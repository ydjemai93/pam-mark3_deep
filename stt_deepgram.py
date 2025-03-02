# stt_deepgram.py
import os
import logging
import threading
import asyncio
from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions
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
        
        # Configuration du client Deepgram
        config = DeepgramClientOptions(api_key=api_key)
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
        """Établit la connexion WebSocket avec Deepgram"""
        try:
            # Initialisation de la connexion live (version 1 de l'API)
            self.dg_connection = self.client.listen.live.v1()
            
            # Configuration des handlers d'événements
            self.dg_connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
            self.dg_connection.on(LiveTranscriptionEvents.Close, self._on_close)

            # Démarrage de la connexion (synchrone)
            self.dg_connection.start(self.options)

            # Boucle de maintien de la connexion
            while not self.stop_flag:
                await asyncio.sleep(0.1)
                
        except Exception as e:
            logging.error(f"Erreur Deepgram : {e}")
            raise

    def _on_transcript(self, connection, message):
        """Gère les événements de transcription"""
        try:
            transcript = message.channel.alternatives[0].transcript
            if not transcript:
                return

            if message.is_final:
                self.on_final(transcript)
            else:
                self.on_partial(transcript)
        except Exception as e:
            logging.error(f"Erreur de transcription : {e}")

    def _on_close(self, connection, message):
        """Gère la fermeture de la connexion"""
        logging.info(f"Connexion Deepgram fermée : {message}")

    def start(self):
        """Démarre le thread de gestion de la connexion"""
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            daemon=True
        )
        self._thread.start()

    def _run_loop(self):
        """Lance la boucle d'événements asyncio"""
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._async_connect())

    def stop(self):
        """Arrête proprement la connexion"""
        self.stop_flag = True
        if self.dg_connection:
            self._loop.call_soon_threadsafe(
                lambda: self.dg_connection.finish()
            )
        if self._thread:
            self._thread.join(timeout=2)
        if self._loop:
            self._loop.close()

    def send_audio(self, data: bytes):
        """Envoie des données audio à Deepgram de manière thread-safe"""
        if self.dg_connection and not self.stop_flag:
            self._loop.call_soon_threadsafe(
                lambda: self.dg_connection.send(data)
            )
