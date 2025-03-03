# agent.py
import uuid
import logging
import threading

from stt_deepgram import DeepgramStreamingSTT
from llm import gpt4_stream
from tts import ElevenLabsStreamer

class StreamingAgent:
    def __init__(self):
        self.sessions = {}  # session_id -> dict d'état

    def start_session(self, ws):
        session_id = str(uuid.uuid4())
        logging.info(f"[Session {session_id}] start")

        sess = {
            "ws": ws,
            "speaking": False,    # L'IA est en train de parler
            "interrupt": False,   # Signal de barge‑in (interruption par l'utilisateur)
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

        # Démarrer la connexion STT
        stt.start()

        self.sessions[session_id] = sess
        return session_id

    def end_session(self, session_id):
        """Terminer proprement la session en arrêtant le STT et en nettoyant l'état."""
        sess = self.sessions.pop(session_id, None)
        if sess:
            # Arrêter le service de transcription en streaming
            sess["stt"].stop()
            logging.info(f"[Session {session_id}] ended")

    def on_user_audio_chunk(self, session_id, chunk_pcm):
        """
        Méthode appelée à chaque chunk audio reçu de l'utilisateur.
        Envoie l'audio au service STT et gère le barge-in si l'agent parlait.
        """
        sess = self.sessions.get(session_id)
        if not sess:
            return
        # Si l'IA est en train de parler, on déclenche l'interruption (barge-in)
        if sess["speaking"]:
            sess["interrupt"] = True
            logging.info(f"[Session {session_id}] barge‑in triggered by user speech")
        # Envoyer le chunk audio au service de reconnaissance vocale (STT)
        sess["stt"].send_audio(chunk_pcm)

    def on_stt_partial(self, session_id, text):
        """Callback pour les transcriptions partielles du STT (optionnel, ici juste log)."""
        logging.debug(f"[Session {session_id}] STT partial: {text}")

    def on_stt_final(self, session_id, text):
        """
        Callback appelée lorsque le STT a finalisé la transcription de la phrase de l'utilisateur.
        Lance la génération de réponse de l'IA en streaming via GPT-4 et TTS.
        """
        sess = self.sessions.get(session_id)
        if not sess or not text.strip():
            return

        # Ajouter la requête de l'utilisateur à la conversation
        sess["conversation"].append({"role": "user", "content": text})
        logging.info(f"[Session {session_id}] User said: {text}")

        def run_gpt():
            sess["speaking"] = True
            sess["interrupt"] = False
            partial_response = ""
            # Générer la réponse token par token en streaming
            for token in gpt4_stream(sess["conversation"]):
                if sess["interrupt"]:
                    logging.info(f"[Session {session_id}] GPT-4 stream interrupted by user")
                    break  # Arrêter la génération si interruption demandée
                partial_response += token
                # Envoyer le token courant au TTS pour une sortie audio progressive
                sess["tts"].stream_text(token)
            # Si la réponse s'est terminée sans interruption, l'ajouter à la conversation
            if not sess["interrupt"]:
                sess["conversation"].append({"role": "assistant", "content": partial_response})
            sess["speaking"] = False

        # Lancer la génération de réponse dans un thread séparé pour ne pas bloquer
        t = threading.Thread(target=run_gpt, daemon=True)
        t.start()

    def send_audio_chunk(self, session_id, pcm_data):
        """
        Envoi d'un chunk audio encodé en µ-law vers la websocket Twilio.
        Cette fonction est appelée par le TTS à chaque chunk généré.
        """
        import audioop, base64, json
        sess = self.sessions.get(session_id)
        if not sess or sess["interrupt"]:
            # Ne pas envoyer de son si la session est terminée ou interrompue par barge-in
            return
        ws = sess["ws"]
        # Convertir PCM 16-bit en µ-law (format attendu par Twilio)
        ulaw_data = audioop.lin2ulaw(pcm_data, 2)
        # Encoder en base64 pour l'envoi JSON
        payload_b64 = base64.b64encode(ulaw_data).decode("utf-8")
        # Envoyer le message audio via WebSocket au format Twilio Media Streams
        ws.send(json.dumps({
            "event": "media",
            "media": {"payload": payload_b64}
        }))
