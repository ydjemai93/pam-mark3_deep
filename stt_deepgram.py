import os
import logging
from deepgram import Deepgram
from deepgram.transcription import LiveTranscriptionEvents

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.dg_connection = None

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")

        deepgram = Deepgram(api_key)
        options = {
            "model": "nova-3",
            "language": "en-US",
            "smart_format": True,
            "encoding": "linear16",
            "channels": 1,
            "sample_rate": 8000,
            "interim_results": True,
            "utterance_end_ms": "1000",
            "vad_events": True,
            "endpointing": 300
        }
        self.dg_connection = deepgram.transcription.live(options)

        self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
        self.dg_connection.on(LiveTranscriptionEvents.Close, lambda code, **kwargs: logging.info(f"Deepgram closed (code {code})"))

    def _on_transcript(self, data, **kwargs):
        transcript = data.channel.alternatives[0].transcript
        if transcript:
            if getattr(data, 'is_final', False):
                self.on_final(transcript)
            else:
                self.on_partial(transcript)

    def send_audio(self, data: bytes):
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")
