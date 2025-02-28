import uuid
import logging
import threading

from stt_assemblyai import AssemblyAIStreamingSTT
from llm import gpt4_stream
from tts import ElevenLabsStreamer

class StreamingAgent:
    def __init__(self):
        # sessions stocke l'état de chaque appel (Twilio WebSocket)
        self.sessions = {}

    def start_session(self, ws):
        """
        Initialise une nouvelle session quand Twilio appelle /audiostream.
        """
        session_id = str(uuid.uuid4())
        logging.info(f"[Session {session_id}] start")

        # On stocke l'état
        sess = {
            "ws": ws,
            "speaking": False,    # True si GPT-4 parle (TTS)
            "interrupt": False,   # True si barge-in
            "conversation": [
                {"role": "system", "content": "You are a helpful FR assistant."},
            ]
        }

        # Crée TTS
        tts = ElevenLabsStreamer(
            on_audio_chunk=lambda pcm: self.send_audio_chunk(session_id, pcm)
        )
        sess["tts"] = tts

        # Crée STT streaming AssemblyAI
        stt = AssemblyAIStreamingSTT(
            on_partial=lambda text: self.on_stt_partial(session_id, text),
            on_final=lambda text: self.on_stt_final(session_id, text),
        )
        sess["stt"] = stt

        # Démarre la connexion STT
        stt.start()

        self.sessions[session_id] = sess
        return session_id

    def end_session(self, session_id):
        """
        Ferme la session quand Twilio 'stop' ou WS clos.
        """
        sess = self.sessions.pop(session_id, None)
        if sess:
            sess["stt"].stop()

    def on_user_audio_chunk(self, session_id, chunk_pcm):
        """
        Reçu depuis Twilio WebSocket (inbound audio).
        On l'envoie au STT. Si IA parlait, c'est un barge-in => interrupt
        """
        sess = self.sessions.get(session_id)
        if not sess:
            return

        # barge-in => l'utilisateur reparle
        if sess["speaking"]:
            sess["interrupt"] = True
            logging.info(f"[Session {session_id}] barge-in triggered")

        # Envoie au STT
        sess["stt"].send_audio(chunk_pcm)

    def on_stt_partial(self, session_id, text):
        """
        Callback partial transcripts (optionnel).
        On peut juste logger.
        """
        logging.debug(f"[Session {session_id}] partial: {text}")

    def on_stt_final(self, session_id, text):
        """
        Callback final transcripts => on appelle GPT-4
        """
        sess = self.sessions.get(session_id)
        if not sess:
            return
        if not text.strip():
            return

        # Ajout message user
        sess["conversation"].append({"role": "user", "content": text})

        def run_gpt():
            sess["speaking"] = True
            sess["interrupt"] = False

            partial_resp = ""
            for token in gpt4_stream(sess["conversation"]):
                if sess["interrupt"]:
                    logging.info(f"[Session {session_id}] GPT interrupted.")
                    break

                partial_resp += token
                # On envoie ce token au TTS (streaming)
                sess["tts"].stream_text(token)

            if not sess["interrupt"]:
                # conversation "officielle"
                sess["conversation"].append({"role": "assistant", "content": partial_resp})

            sess["speaking"] = False

        # Lance GPT-4 en thread
        t = threading.Thread(target=run_gpt, daemon=True)
        t.start()

    def send_audio_chunk(self, session_id, pcm_data):
        """
        Reçoit un chunk PCM 16 bits du TTS => convertit en ulaw => envoie WebSocket Twilio
        """
        import audioop
        import base64
        import json

        sess = self.sessions.get(session_id)
        if not sess:
            return

        # Si barge-in => on arrête l'envoi
        if sess["interrupt"]:
            return

        ws = sess["ws"]
        ulaw = audioop.lin2ulaw(pcm_data, 2)
        b64 = base64.b64encode(ulaw).decode("utf-8")

        ws.send(json.dumps({
            "event": "media",
            "media": {"payload": b64}
        }))
