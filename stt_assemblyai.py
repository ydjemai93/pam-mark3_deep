# stt_assemblyai.py
import os
import logging
import assemblyai as aai
import threading

class AssemblyAIStreamingSTT:
    """
    Gère la connexion streaming à AssemblyAI :
      - connect() ouvre la connexion,
      - send_audio(chunk) envoie l'audio,
      - Les callbacks on_partial(text) et on_final(text) gèrent la transcription.
    """

    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self.stop_flag = False
        self.transcriber = None
        self._thread = None

        # Configure la clé API AssemblyAI
        aai.settings.api_key = os.getenv("ASSEMBLYAI_API_KEY")

        # Instancier le RealtimeTranscriber avec les paramètres requis.
        # Remarquez que nous passons ici les callbacks obligatoires 'on_data' et 'on_error'
        self.transcriber = aai.RealtimeTranscriber(
            encoding=aai.AudioEncoding.pcm_s16le,   # PCM 16 bits little-endian
            sample_rate=8000,                       # 8000 Hz pour l'audio inbound de Twilio
            end_utterance_silence_threshold=700,    # fin d'utterance après 700 ms de silence
            on_data=self._on_result,                # Callback pour recevoir les résultats
            on_error=self._on_error                 # Callback pour les erreurs
        )
        # Assigner le callback de fermeture
        self.transcriber.on_close = self._on_close

    def start(self):
        """Ouvre la connexion streaming en appelant connect()."""
        def run_transcriber():
            try:
                self.transcriber.connect()
            except Exception as e:
                logging.error(f"AssemblyAI transcriber error: {e}")

        self._thread = threading.Thread(target=run_transcriber, daemon=True)
        self._thread.start()

    def stop(self):
        """Arrête la session de transcription."""
        self.stop_flag = True
        if self.transcriber:
            self.transcriber.close()
        if self._thread:
            self._thread.join()

    def send_audio(self, pcm_data: bytes):
        """Envoie un chunk PCM16 (8 kHz) à AssemblyAI via send_data()."""
        if not self.stop_flag and self.transcriber:
            self.transcriber.send_data(pcm_data)

    def _on_result(self, response):
        """
        Callback déclenché pour chaque résultat de transcription.
        L'objet response possède des attributs tels que message_type et transcript.
        """
        if response.message_type == aai.RealtimeMessageType.FINAL:
            text = response.transcript
            if self.on_final:
                self.on_final(text)
        else:
            partial_text = response.transcript
            if self.on_partial:
                self.on_partial(partial_text)

    def _on_error(self, error_msg: str):
        logging.error(f"[AssemblyAI] Error: {error_msg}")

    def _on_close(self):
        logging.info("[AssemblyAI] Streaming closed")
