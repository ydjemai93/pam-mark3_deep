import os
import logging
from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions

class DeepgramStreamingSTT:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.stop_flag = False
        self.dg_connection = None

        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        
        # Créer le client Deepgram (v3.1.0)
        deepgram_client = DeepgramClient(api_key)
        
        # Configurer les options de streaming
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
        
        # Obtenir une connexion WebSocket pour l'écoute
        self.dg_connection = deepgram_client.listen.websocket.v("1")
        
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
                logging.error(f"Error processing transcript: {e}")

        def handle_error(_conn, error, **kwargs):
            logging.error(f"Deepgram error: {error}")

        def handle_utterance_end(_conn, utt_end, **kwargs):
            logging.info(f"Utterance ended: {utt_end}")

        self.dg_connection.on(LiveTranscriptionEvents.Transcript, handle_transcript)
        self.dg_connection.on(LiveTranscriptionEvents.Error, handle_error)
        self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, handle_utterance_end)

    def start(self):
        """Démarre la transcription en streaming."""
        self.dg_connection.start(self.options)

    def stop(self):
        """Arrête la connexion Deepgram proprement."""
        if self.dg_connection:
            self.dg_connection.finish()

    def send_audio(self, data: bytes):
        """Envoie un chunk audio (PCM16) à Deepgram."""
        if self.dg_connection:
            try:
                self.dg_connection.send(data)
            except Exception as e:
                logging.error(f"Deepgram send error: {e}")
