# stt_deepgram.py
import os
import logging
import threading
import asyncio
from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions,
    LiveClient
)

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
        
        # Configuration du client Deepgram v3
        config = DeepgramClientOptions(
            api_key=api_key,
            options={"keepalive": "true"}
        )
        self.client = DeepgramClient(config=config)

        # Options de streaming
        self.options = LiveOptions(
            model="nova-3",
            language="en-US",
            smart_format=True,
            encoding="linear16",
            channels=1,
            sample_rate=8000,
            interim_results=True,
            utterance_end_ms="1000",
            vad_events=True,
            endpointing=300
        )

    async def _async_connect(self):
        """Établir la connexion Deepgram et configurer les handlers"""
        try:
            self.dg_connection = self.client.listen.live.v("1")
            
            # Configurer les handlers d'événements
            self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
            self.dg_connection.on(LiveTranscriptionEvents.Close, self._on_close)

            # Démarrer la connexion
            await self.dg_connection.start(self.options)

            # Maintenir la connexion active
            while not self.stop_flag:
                await asyncio.sleep(0.1)
                
        except Exception as e:
            logging.error(f"Deepgram connection error: {e}")
            raise

    def _on_transcript(self, connection, message):
        """Handler pour les résultats de transcription"""
        transcript = message.channel.alternatives[0].transcript
        if not transcript:
            return

        if message.is_final:
            if self.on_final:
                self.on_final(transcript)
        else:
            if self.on_partial:
                self.on_partial(transcript)

    def _on_close(self, connection, message):
        logging.info(f"Deepgram connection closed: {message}")

    def start(self):
        """Démarrer la connexion dans un thread asyncio dédié"""
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, 
            daemon=True
        )
        self._thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._async_connect())

    def stop(self):
        """Arrêter la connexion"""
        self.stop_flag = True
        if self.dg_connection:
            self._loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self.dg_connection.finish())
            )
        if self._thread:
            self._thread.join(timeout=2)
        if self._loop:
            self._loop.close()

    def send_audio(self, data: bytes):
        """Envoyer des données audio de manière thread-safe"""
        if self.dg_connection and not self.stop_flag:
            self._loop.call_soon_threadsafe(
                lambda: self.dg_connection.send(data)
            )
