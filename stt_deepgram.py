# stt_deepgram.py
import os
import logging
import threading
from deepgram import Deepgram

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.stop_flag = False
        self.dg_connection = None
        self._thread = None

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        
        # Instancier le client Deepgram
        dg = Deepgram(api_key)

        # Définir les options sous forme de dictionnaire
        options = {
            "model": "nova-3",
            "language": "en-US",         # Deepgram Streaming est disponible en anglais
            "smart_format": True,
            "encoding": "linear16",      # PCM16
            "channels": 1,
            "sample_rate": 8000,         # 8000 Hz pour correspondre à Twilio
            "interim_results": True,
            "utterance_end_ms": 1000,    # fin d'utterance après 1000 ms de silence
            "vad_events": True,
            "endpointing": 300
        }
        
        # Créer la connexion en mode streaming via l'API Deepgram
        self.dg_connection = dg.transcription.live(options)
        
        # Associer les callbacks aux événements en utilisant leurs noms
        self.dg_connection.on("Transcript", self._on_transcript)
        self.dg_connection.on("UtteranceEnd", self._on_utterance_end)

    def start(self):
        def run_connection():
            try:
                self.dg_connection.start()
            except Exception as e:
                logging.error(f"Deepgram connection error: {e}")
        self._thread = threading.Thread(target=run_connection, daemon=True)
        self._thread.start()

    def stop(self):
        self.stop_flag = True
        if self.dg_connection:
            self.dg_connection.finish()
        if self._thread:
            self._thread.join()

    def send_audio(self, data: bytes):
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")

    def _on_transcript(self, result, **kwargs):
        try:
            transcript = result["channel"]["alternatives"][0]["transcript"]
            if result.get("is_final", False):
                if self.on_final:
                    self.on_final(transcript)
            else:
                if self.on_partial:
                    self.on_partial(transcript)
        except Exception as e:
            logging.error(f"Error processing transcript: {e}")

    def _on_utterance_end(self, data, **kwargs):
        logging.info(f"Utterance ended: {data}")
