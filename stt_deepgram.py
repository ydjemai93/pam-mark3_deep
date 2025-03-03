import uuid
import logging
import threading

from stt_deepgram import DeepgramStreamingSTT
from llm import gpt4_stream
from tts import ElevenLabsStreamer

class StreamingAgent:
    def __init__(self):
        self.sessions = {}

    def start_session(self, ws):
        session_id = str(uuid.uuid4())
        logging.info(f"[Session {session_id}] start")

        sess = {
            "ws": ws,
            "speaking": False,
            "interrupt": False,
            "conversation": [
                {"role": "system", "content": "You are a helpful assistant."},
            ]
        }

        # Instanciation du TTS (ElevenLabs)
        tts = ElevenLabsStreamer(
            on_audio_chunk=lambda pcm: self.send_audio_chunk(session_id, pcm)
        )
        sess["tts"] = tts

        # Instanciation du STT (Deepgram)
        stt = DeepgramStreamingSTT(
            on_partial=lambda text: self.on_stt_partial(session_id, text),
            on_final=lambda text: self.on_stt_final(session_id, text)
        )
        sess["stt"] = stt

        # Démarrer l'écoute en streaming
        stt.start()

        self.sessions[session_id] = sess
        return session_id

    def end_session(self, session_id):
        """Arrête une session active et libère les ressources"""
        sess = self.sessions.pop(session_id, None)
        if sess:
            logging.info(f"[Session {session_id}] ended")
            sess["stt"].stop()

    def on_user_audio_chunk(self, session_id, chunk_pcm):
        """Reçoit un morceau audio de Twilio et l'envoie à Deepgram"""
        sess = self.sessions.get(session_id)
        if not sess:
            return
        # Si l'IA parle, on déclenche le barge-in
        if sess["speaking"]:
            sess["interrupt"] = True
            logging.info(f"[Session {session_id}] barge-in triggered")
        sess["stt"].send_audio(chunk_pcm)

    def on_stt_partial(self, session_id, text):
        """Callback pour les résultats intermédiaires de la reconnaissance vocale"""
        logging.debug(f"[Session {session_id}] STT partial: {text}")

    def on_stt_final(self, session_id, text):
        """Callback pour les résultats finaux de la reconnaissance vocale"""
        sess = self.sessions.get(session_id)
        if not sess or not text.strip():
            return

        sess["conversation"].append({"role": "user", "content": text})

        def run_gpt():
            sess["speaking"] = True
            sess["interrupt"] = False
            partial_response = ""
            for token in gpt4_stream(sess["conversation"]):
                if sess["interrupt"]:
                    logging.info(f"[Session {session_id}] GPT stream interrupted")
                    break
                partial_response += token
                sess["tts"].stream_text(token)

            if not sess["interrupt"]:
                sess["conversation"].append({"role": "assistant", "content": partial_response})

            sess["speaking"] = False

        t = threading.Thread(target=run_gpt, daemon=True)
        t.start()

    def send_audio_chunk(self, session_id, pcm_data):
        """Envoie un chunk audio encodé en u-law vers Twilio"""
        import audioop, base64, json
        sess = self.sessions.get(session_id)
        if not sess or sess["interrupt"]:
            return
        ws = sess["ws"]
        ulaw_data = audioop.lin2ulaw(pcm_data, 2)
        payload_b64 = base64.b64encode(ulaw_data).decode("utf-8")
        ws.send(json.dumps({
            "event": "media",
            "media": {"payload": payload_b64}
        }))
