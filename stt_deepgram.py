# stt_deepgram.py
import os
import logging
import threading
import asyncio
from deepgram import Deepgram

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
        deepgram = Deepgram(api_key)
        
        # Définir les options de streaming sous forme de dictionnaire
        options = {
            "model": "nova-3",
            "language": "en-US",         # Deepgram Streaming fonctionne en anglais
            "smart_format": True,
            "encoding": "linear16",      # PCM16
            "channels": 1,
            "sample_rate": 8000,         # Pour correspondre à Twilio
            "interim_results": True,
            "utterance_end_ms": "1000",  # 1000 ms de silence pour clore une utterance
            "vad_events": True,
            "endpointing": 300
        }
        
        # Créer un nouvel event loop pour obtenir la connexion Deepgram
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        # Ici, live(options) est une coroutine qu'il faut await pour obtenir l'objet de connexion.
        self.dg_connection = loop.run_until_complete(deepgram.transcription.live(options))
        self._loop = loop

    async def _async_listen(self):
        """
        Itère sur les messages reçus sur la connexion Deepgram en streaming.
        Pour chaque message, on analyse le type et on appelle les callbacks appropriés.
        """
        try:
            async for message in self.dg_connection:
                # Exemple de message "Results" :
                # {
                #   "type": "Results",
                #   "channel": {
                #       "alternatives": [ { "transcript": "Hello world", ... } ]
                #   },
                #   "is_final": True, ...
                # }
                msg_type = message.get("type")
                if msg_type == "Results":
                    transcript = message.get("channel", {}) \
                                         .get("alternatives", [{}])[0] \
                                         .get("transcript", "")
                    if transcript:
                        if message.get("is_final", False):
                            if self.on_final:
                                self.on_final(transcript)
                        else:
                            if self.on_partial:
                                self.on_partial(transcript)
                elif msg_type == "UtteranceEnd":
                    self._on_utterance_end(message)
                # Vous pouvez ajouter d'autres cas selon vos besoins.
        except Exception as e:
            logging.error(f"Deepgram async listen error: {e}")

    def _on_utterance_end(self, data):
        logging.info(f"Utterance ended: {data}")

    def start(self):
        """Démarre l'écoute en streaming dans un thread séparé."""
        def run_listener():
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            new_loop.run_until_complete(self._async_listen())
        self._thread = threading.Thread(target=run_listener, daemon=True)
        self._thread.start()

    def stop(self):
        """Arrête la connexion Deepgram et ferme le thread et l'event loop."""
        self.stop_flag = True
        if self.dg_connection:
            self.dg_connection.finish()
        if self._thread:
            self._thread.join()
        if self._loop:
            self._loop.stop()
            self._loop.close()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")
