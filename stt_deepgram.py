# stt_deepgram.py
import os
import logging
import asyncio
import threading
from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.dg_connection = None
        self._thread = None
        self._loop = None
        self.stop_flag = False

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        
        # Création du client Deepgram (version 3)
        deepgram_client = DeepgramClient(api_key)
        # Obtenir l'objet WebSocket pour la version "1"
        self.dg_connection = deepgram_client.listen.websocket.v("1")

    def _initialize_connection(self):
        # Attacher les gestionnaires d'événements pour surveiller la connexion
        self.dg_connection.on(
            LiveTranscriptionEvents.Open,
            lambda: logging.info("Deepgram WebSocket opened")
        )
        self.dg_connection.on(
            LiveTranscriptionEvents.Close,
            lambda code=None: logging.info(f"Deepgram WebSocket closed (code={code})")
        )
        self.dg_connection.on(
            LiveTranscriptionEvents.Error,
            lambda error=None: logging.error(f"Deepgram WebSocket error: {error}")
        )
        
        # Gestionnaire pour les transcriptions
        def handle_transcript(result, **kwargs):
            try:
                transcript = result.channel.alternatives[0].transcript
                if transcript:
                    if getattr(result, "is_final", False):
                        if self.on_final:
                            self.on_final(transcript)
                    else:
                        if self.on_partial:
                            self.on_partial(transcript)
            except Exception as e:
                logging.error(f"Error processing transcript: {e}")

        self.dg_connection.on(
            LiveTranscriptionEvents.Transcript,
            handle_transcript
        )
        self.dg_connection.on(
            LiveTranscriptionEvents.UtteranceEnd,
            lambda metadata, **kwargs: self._on_utterance_end(metadata)
        )
        
        # Préparer les options de transcription
        live_options = LiveOptions(
            model="nova-3",
            language="en-US",
            smart_format=True,
            encoding="linear16",  # Assurez-vous que l'audio est converti en PCM 16-bit
            channels=1,
            sample_rate=8000,
            interim_results=True,
            utterance_end_ms=1000,  # valeur entière
            vad_events=True,
            endpointing=300
        )
        
        # Démarrer la connexion WebSocket Deepgram en utilisant start()
        success = self.dg_connection.start(live_options)
        if not success:
            logging.error("Deepgram WebSocket connection failed to start")
            raise RuntimeError("Unable to start Deepgram STT WebSocket connection")
    
    def _on_utterance_end(self, metadata):
        logging.info(f"Utterance ended: {metadata}")

    def start(self):
        """Démarre la connexion Deepgram dans un thread dédié avec son event loop."""
        def run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            try:
                self._initialize_connection()
                # Garder le loop actif tant que la connexion n'est pas arrêtée
                while not self.stop_flag:
                    loop.run_until_complete(asyncio.sleep(0.1))
            except Exception as e:
                logging.error(f"Error in Deepgram listener thread: {e}")

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def stop(self):
        """Arrête la connexion Deepgram et ferme l'event loop associé."""
        self.stop_flag = True
        if self.dg_connection:
            try:
                self.dg_connection.finish()
            except Exception as e:
                logging.error(f"Error closing Deepgram connection: {e}")
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
                logging.debug(f"Sent audio chunk of size {len(data)} bytes")
            except Exception as e:
                logging.error(f"Error sending audio chunk: {e}")
