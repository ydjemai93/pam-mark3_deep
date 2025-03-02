# stt_deepgram.py
import os
import logging
import threading
from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

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
        deepgram = DeepgramClient(api_key)
        
        # Créer la connexion via la méthode listen.websocket.v("1")
        self.dg_connection = deepgram.listen.websocket.v("1")
        
        # Configurer les options Deepgram sous forme d'un objet LiveOptions
        options = LiveOptions(
            model="nova-3",
            language="en-US",         # Deepgram Streaming est disponible en anglais
            smart_format=True,
            encoding="linear16",      # PCM16
            channels=1,
            sample_rate=8000,         # Pour correspondre à Twilio
            interim_results=True,
            utterance_end_ms="1000",
            vad_events=True,
            endpointing=300
        )
        self.options = options

        # Associer les callbacks pour les événements
        self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
        self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self._on_utterance_end)

    def start(self):
        """Démarre la connexion Deepgram en appelant start(options) dans un thread dédié."""
        def run_connection():
            try:
                if not self.dg_connection.start(self.options):
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
        """Callback déclenché à chaque résultat de transcription (partiel ou final)."""
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
