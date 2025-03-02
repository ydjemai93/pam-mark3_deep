# stt_deepgram.py
import os
import logging
import threading
import asyncio
from deepgram import Deepgram
from deepgram.transcription import LiveTranscriptionEvents

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.stop_flag = False
        self.dg_connection = None
        self._loop = None
        self._thread = None

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        
        self.deepgram = Deepgram(api_key)
        self.options = {
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

    async def _async_connect(self):
        """Établir la connexion Deepgram et configurer les handlers"""
        try:
            self.dg_connection = await self.deepgram.transcription.live(self.options)
            
            # Configurer les handlers d'événements
            self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
            self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, self._on_utterance_end)
            self.dg_connection.on(LiveTranscriptionEvents.Close, self._on_close)
            
            # Maintenir la connexion active
            while not self.stop_flag:
                await asyncio.sleep(1)
                
        except Exception as e:
            logging.error(f"Deepgram connection error: {e}")

    def _on_transcript(self, message):
        """Handler pour les résultats de transcription"""
        transcript = message.get('channel', {}).get('alternatives', [{}])[0].get('transcript', '')
        if transcript:
            if message.get('is_final', False):
                if self.on_final:
                    self.on_final(transcript)
            else:
                if self.on_partial:
                    self.on_partial(transcript)

    def _on_utterance_end(self, data):
        logging.info(f"Utterance ended: {data}")

    def _on_close(self, data):
        logging.info(f"Deepgram connection closed: {data}")

    def start(self):
        """Démarrer la connexion dans un thread asyncio dédié"""
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._async_connect())

    def stop(self):
        """Arrêter la connexion"""
        self.stop_flag = True
        if self.dg_connection:
            # Appeler finish() de manière asynchrone
            self._loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self.dg_connection.finish())
            )
        if self._thread:
            self._thread.join(timeout=1)
        if self._loop:
            self._loop.close()

    def send_audio(self, data: bytes):
        """Envoyer des données audio de manière thread-safe"""
        if self.dg_connection and not self.stop_flag:
            self._loop.call_soon_threadsafe(
                lambda: self.dg_connection.send(data)
            )
