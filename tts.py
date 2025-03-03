import os
import requests
import subprocess
import threading
import logging

class ElevenLabsStreamer:
    def __init__(self, voice_id="TxGEqnHWrfWFTfG4DY78", on_audio_chunk=None):
        self.api_key = os.environ.get("ELEVENLABS_API_KEY", "")
        self.voice_id = voice_id
        self.on_audio_chunk = on_audio_chunk

    def stream_text(self, text: str):
        if not text.strip():
            return
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream"
        headers = {
            "xi-api-key": self.api_key,
            "Accept": "audio/mpeg",
            "Content-Type": "application/json"
        }
        payload = {
            "text": text,
            "voice_settings": {"stability": 0.3, "similarity_boost": 0.75}
        }

        try:
            r = requests.post(url, headers=headers, json=payload, stream=True)
            r.raise_for_status()

            for chunk in r.iter_content(chunk_size=1024):
                if self.on_audio_chunk:
                    self.on_audio_chunk(chunk)

        except Exception as e:
            logging.error(f"ElevenLabs streaming error: {e}")
