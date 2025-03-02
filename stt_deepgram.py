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
        
        # Instancier le client Deepgram avec la clé API
        deepgram = Deepgram(api_key)
        
        # Définir les options de streaming sous forme de dictionnaire
        options = {
            "model": "nova-3",
            "language": "en-US",         # Deepgram Streaming fonctionne en anglais
            "smart_format": True,
            "encoding": "linear16",      # PCM16
            "channels": 1,
            "sample_rate": 8000,         # Pour correspondre à Twilio
            "interim_results": True,
            "utterance_end_ms": "1000",  # 1000 ms de silence pour clore une utterance
            "vad_events": True,
            "endpointing": 300
        }
        
        # Créer la connexion en streaming avec Deepgram
        # La méthode transcription.live() accepte un dictionnaire d'options.
        self.dg_connection = deepgram.transcription.live(options)
        
        # Associer les callbacks aux événements Deepgram
        self.dg_connection.on("Transcript", self._on_transcript)
        self.dg_connection.on("UtteranceEnd", self._on_utterance_end)

    def start(self):
        """Démarre la connexion Deepgram dans un thread dédié."""
        def run_connection():
            try:
                if not self.dg_connection.start():
                    logging.error("Failed to start Deepgram connection")
            except Exception as e:
                logging.error(f"Deepgram connection error: {e}")
        self._thread = threading.Thread(target=run_connection, daemon=True)
        self._thread.start()

    def stop(self):
        """Ferme la connexion et arrête le thread."""
        self.stop_flag = True
        if self.dg_connection:
            self.dg_connection.finish()
        if self._thread:
            self._thread.join()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")

    def _on_transcript(self, result, **kwargs):
        """
        Callback déclenché pour chaque résultat de transcription.
        L'objet result contient, par exemple, result["channel"]["alternatives"][0]["transcript"]
        et le booléen result.get("is_final", False).
        """
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
