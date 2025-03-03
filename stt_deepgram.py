# stt_deepgram.py
import os
import logging
import asyncio
import threading

from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.stop_flag = False
        self.dg_connection = None
        self._thread = None
        self._loop = None

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        
        # Créer le client Deepgram pour la version 3.1.0
        self.deepgram_client = DeepgramClient(api_key)
        
        # Préparer les options de transcription
        self.options = LiveOptions(
            model="nova-3",
            language="en-US",
            smart_format=True,
            encoding="linear16",    # Assurez-vous que l'audio est converti en PCM 16-bit
            channels=1,
            sample_rate=8000,
            interim_results=True,
            utterance_end_ms=1000,  # valeur entière, pas de chaîne
            vad_events=True,
            endpointing=300
        )

    async def _async_listen(self):
        """
        Cette coroutine permet de maintenir l'event loop actif afin que les callbacks
        Deepgram soient traités. Ici, on attend indéfiniment en petites pauses.
        """
        try:
            while not self.stop_flag:
                await asyncio.sleep(0.1)
        except Exception as e:
            logging.error(f"Erreur dans la boucle d'écoute Deepgram: {e}")

    def start(self):
        """Démarre la connexion et l'écoute en streaming dans un thread séparé."""
        def run_listener():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            logging.info("Connexion au service Deepgram en cours...")
            try:
                # Établir la connexion WebSocket Deepgram sur ce loop
                self.dg_connection = loop.run_until_complete(
                    self.deepgram_client.transcription.live(self.options)
                )
                logging.info("Connexion Deepgram établie avec succès.")
            except Exception as e:
                logging.error(f"Erreur lors de la connexion à Deepgram: {e}")
                return

            # Définir les callbacks pour les événements Deepgram
            def handle_transcript(_conn, result, **kwargs):
                try:
                    transcript = result.channel.alternatives[0].transcript
                    if transcript:
                        if getattr(result, 'is_final', False):
                            if self.on_final:
                                self.on_final(transcript)
                        else:
                            if self.on_partial:
                                self.on_partial(transcript)
                except Exception as e:
                    logging.error(f"Erreur dans le traitement de la transcription: {e}")

            def handle_error(_conn, error, **kwargs):
                logging.error(f"Deepgram error: {error}")

            def handle_utterance_end(_conn, utt_end, **kwargs):
                logging.info(f"Fin d'une utterance: {utt_end}")

            self.dg_connection.on(LiveTranscriptionEvents.Transcript, handle_transcript)
            self.dg_connection.on(LiveTranscriptionEvents.Error, handle_error)
            self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, handle_utterance_end)

            try:
                loop.run_until_complete(self._async_listen())
            except Exception as e:
                logging.error(f"Erreur pendant l'écoute Deepgram: {e}")

        self._thread = threading.Thread(target=run_listener, daemon=True)
        self._thread.start()

    def stop(self):
        """Arrête la connexion et ferme l'event loop."""
        self.stop_flag = True
        if self.dg_connection:
            try:
                self.dg_connection.finish()
            except Exception as e:
                logging.error(f"Erreur lors de la fermeture de la connexion Deepgram: {e}")
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
                logging.debug(f"Chunk audio envoyé (taille {len(data)} octets)")
            except Exception as e:
                logging.error(f"Erreur lors de l'envoi du chunk audio: {e}")
