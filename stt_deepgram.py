# stt_deepgram.py
import os
import logging
import threading
from deepgram import Deepgram, LiveOptions, LiveTranscriptionEvents

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
        
        # Configurer les options pour la transcription en direct
        options = LiveOptions(
            model="nova-3",
            language="en-US",       # Deepgram streaming est disponible en anglais
            smart_format=True,
            encoding="linear16",    # format audio PCM16
            channels=1,
            sample_rate=8000,       # à ajuster selon le flux (par exemple, 8000 Hz si c'est le cas)
            interim_results=True,
            utterance_end_ms="1000",
            vad_events=True,
            endpointing=300
        )
        
        # Créer la connexion en mode streaming
        self.dg_connection = dg.transcription.live(options)
        
        # Assigner les callbacks pour les événements Deepgram
        self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
        self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self._on_utterance_end)

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
