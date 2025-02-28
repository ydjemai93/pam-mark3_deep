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
        self.client = DeepgramClient(api_key)

    def start(self):
        # Création de la connexion WebSocket Deepgram (version 1)
        self.dg_connection = self.client.listen.websocket.v("1")
        # Configuration des callbacks
        self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
        self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self._on_utterance_end)
        # Options Deepgram
        options = LiveOptions(
            model="nova-3",
            language="en-US",       # Deepgram Streaming est disponible uniquement en anglais
            smart_format=True,
            encoding="linear16",    # PCM16
            channels=1,
            sample_rate=8000,       # Pour correspondre à Twilio (8000 Hz)
            interim_results=True,
            utterance_end_ms="1000",
            vad_events=True,
            endpointing=300
        )
        def run_connection():
            try:
                if not self.dg_connection.start(options):
                    logging.error("Failed to start Deepgram connection")
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
        """
        Callback pour traiter les messages de transcription.
        Si result["is_final"] est True, c'est un résultat final.
        Sinon, c'est un résultat partiel.
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
