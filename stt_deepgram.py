import os
import logging
# Suppression de l'import obsolète Deepgram et LiveTranscriptionEvents
# from deepgram import Deepgram        # Ancien
# from deepgram.transcription import LiveTranscriptionEvents  # Ancien

# Nouveaux imports pour la v3.1.0
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
        
        # Instancier le nouveau client Deepgram (v3)
        deepgram_client = DeepgramClient(api_key)
        
        # Préparer les options de transcription en utilisant LiveOptions
        options = LiveOptions(
            model="nova-3",
            language="en-US",
            smart_format=True,
            encoding="linear16",    # PCM16
            channels=1,
            sample_rate=8000,       # correspond à Twilio
            interim_results=True,
            utterance_end_ms="1000",  # 1000 ms de silence pour clore une utterance
            vad_events=True,
            endpointing=300
        )
        
        # Créer la connexion WebSocket Deepgram (API v1)
        self.dg_connection = deepgram_client.listen.websocket.v("1")  # **Nouveau** :contentReference[oaicite:0]{index=0}
        
        # Définir les callbacks pour les événements de transcription
        def handle_transcript(_conn, result, **kwargs):
            """Callback pour chaque transcription partielle/finale."""
            if result is None:
                return
            # Extraire le texte transcrit du résultat
            transcript = result.channel.alternatives[0].transcript if result.channel.alternatives else ""
            if transcript:
                if hasattr(result, "is_final") and result.is_final:
                    # Résultat final
                    if self.on_final:
                        self.on_final(transcript)
                else:
                    # Résultat partiel
                    if self.on_partial:
                        self.on_partial(transcript)
        
        def handle_error(_conn, error, **kwargs):
            """Callback en cas d’erreur de la transcription."""
            logging.error(f"Deepgram error: {error}")
        
        def handle_utterance_end(_conn, utt_end, **kwargs):
            """Callback à la fin d’une utterance (pause détectée)."""
            self._on_utterance_end(utt_end)
        
        # Enregistrer les callbacks sur les événements correspondants
        self.dg_connection.on(LiveTranscriptionEvents.Transcript, handle_transcript)   # **Nouveau** :contentReference[oaicite:1]{index=1}
        self.dg_connection.on(LiveTranscriptionEvents.Error, handle_error)             # **Nouveau**
        self.dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, handle_utterance_end)  # **Nouveau**

        # (Optionnel) on peut aussi écouter l’ouverture/fermeture si besoin :
        # self.dg_connection.on(LiveTranscriptionEvents.Open, lambda *args, **kw: logging.info("Connexion Deepgram ouverte"))
        # self.dg_connection.on(LiveTranscriptionEvents.Close, lambda *args, **kw: logging.info("Connexion Deepgram fermée"))

        # Conserver les options pour démarrer plus tard
        self.options = options

    def start(self):
        """Démarre l’écoute en streaming."""
        # Lancement de la transcription live (non bloquant)
        self.dg_connection.start(self.options)  # **Nouveau** – lance le WebSocket :contentReference[oaicite:2]{index=2}&#8203;:contentReference[oaicite:3]{index=3}

    def stop(self):
        """Arrête la connexion Deepgram et ferme proprement."""
        if self.dg_connection:
            self.dg_connection.finish()  # ferme la connexion WebSocket
