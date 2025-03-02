# stt_deepgram.py
import os
import logging
import threading
import asyncio
from deepgram import Deepgram  # On n'importe que Deepgram depuis le SDK officiel

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
        
        # Définir les options de streaming en tant que dictionnaire
        options = {
            "model": "nova-3",
            "language": "en-US",         # Deepgram streaming est disponible en anglais
            "smart_format": True,
            "encoding": "linear16",      # format audio PCM16
            "channels": 1,
            "sample_rate": 8000,         # 8000 Hz pour correspondre à Twilio
            "interim_results": True,
            "utterance_end_ms": "1000",
            "vad_events": True,
            "endpointing": 300
        }
        
        # Créer un nouvel event loop et attendre la connexion Deepgram
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self.dg_connection = loop.run_until_complete(dg.transcription.live(options))
        
        # Maintenant, dg_connection est un objet sur lequel on peut appeler .on()
        self.dg_connection.on("Transcript", self._on_transcript)
        self.dg_connection.on("UtteranceEnd", self._on_utterance_end)
        
        self._loop = loop

    def start(self):
        """Démarre la connexion Deepgram dans un thread séparé."""
        def run_connection():
            try:
                self.dg_connection.start()
            except Exception as e:
                logging.error(f"Deepgram connection error: {e}")
        self._thread = threading.Thread(target=run_connection, daemon=True)
        self._thread.start()

    def stop(self):
        """Ferme la connexion et arrête le thread et l'event loop."""
        self.stop_flag = True
        if self.dg_connection:
            self.dg_connection.finish()
        if self._thread:
            self._thread.join()
        if self._loop:
            self._loop.stop()
            self._loop.close()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")

    def _on_transcript(self, result, **kwargs):
        """Callback appelé lors de la réception d'une transcription (partielle ou finale)."""
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
        """Callback appelé à la fin d'une utterance."""
        logging.info(f"Utterance ended: {data}")
