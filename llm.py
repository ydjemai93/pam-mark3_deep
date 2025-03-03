# llm.py
import os
import openai
import queue
import threading
from openai import AssistantEventHandler

# Configuration de la clé API OpenAI
openai.api_key = os.getenv("OPENAI_API_KEY")

class TokenQueueHandler(AssistantEventHandler):
    def __init__(self):
        self.q = queue.Queue()
        self.done = False

    def on_text_delta(self, delta, snapshot):
        # Appelé pour chaque delta (token partiel) reçu
        self.q.put(delta.value)

    def on_text_created(self, text):
        # Appelé quand le texte complet est créé
        self.q.put(text)

    def on_run_completed(self):
        # Signal que le run est terminé
        self.done = True

def gpt4_stream(messages):
    """
    Crée un thread de conversation, ajoute les messages, lance un Run en streaming
    via l'assistant personnalisé et renvoie un générateur de tokens.
    """
    client = openai  # Utilisation du module openai configuré
    # Étape 1 : Créer un Thread pour la conversation
    thread = client.beta.threads.create()
    
    # Étape 2 : Ajouter les messages de la conversation au Thread
    for msg in messages:
        client.beta.threads.messages.create(
            thread_id=thread.id,
            role=msg["role"],
            content=msg["content"]
        )
    
    # Étape 3 : Créer un EventHandler pour collecter les tokens
    handler = TokenQueueHandler()
    
    # Étape 4 : Lancer le Run en mode streaming avec l'assistant personnalisé
    stream = client.beta.threads.runs.stream(
        thread_id=thread.id,
        assistant_id="asst_Tzai3Ek76LoSaoBTASSYLIqF",
        instructions="",  # Vous pouvez ajouter des instructions supplémentaires ici
        event_handler=handler,
    )
    
    # Lancer le streaming dans un thread séparé afin de ne pas bloquer
    def run_stream():
        stream.until_done()
    t = threading.Thread(target=run_stream, daemon=True)
    t.start()
    
    # Étape 5 : Yielder les tokens dès qu'ils arrivent dans la queue, jusqu'à la fin du Run
    while not handler.done or not handler.q.empty():
        try:
            token = handler.q.get(timeout=0.1)
            yield token
        except queue.Empty:
            pass
