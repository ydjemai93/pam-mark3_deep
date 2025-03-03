# llm.py
import os
import openai
import queue
import threading

openai.api_key = os.getenv("OPENAI_API_KEY")

# Tenter d'importer AssistantEventHandler ; sinon, on le définit localement.
try:
    from openai import AssistantEventHandler
except ImportError:
    class AssistantEventHandler:
        def on_text_created(self, text): pass
        def on_text_delta(self, delta, snapshot): pass
        def on_tool_call_created(self, tool_call): pass
        def on_tool_call_delta(self, delta, snapshot): pass

class TokenQueueHandler(AssistantEventHandler):
    def __init__(self):
        self.q = queue.Queue()
        self.done = False

    def on_text_delta(self, delta, snapshot):
        # Ajoute chaque delta (token partiel) dans la file
        self.q.put(delta.value)

    def on_text_created(self, text):
        # Ajoute le texte complet une fois généré et signale la fin du run
        self.q.put(text)
        self.done = True

    def on_run_completed(self):
        # Méthode optionnelle pour signaler la fin du run
        self.done = True

def gpt4_stream(messages):
    """
    Crée un Thread de conversation, ajoute les messages,
    lance un Run en streaming via l'assistant personnalisé (ID fourni)
    et renvoie un générateur de tokens au fur et à mesure.
    """
    client = openai  # Utilise le module openai configuré
    # Étape 1 : Créer un Thread pour la conversation
    thread = client.beta.threads.create()
    
    # Étape 2 : Ajouter chaque message au Thread
    for msg in messages:
        client.beta.threads.messages.create(
            thread_id=thread.id,
            role=msg["role"],
            content=msg["content"]
        )
    
    # Étape 3 : Créer un EventHandler personnalisé pour collecter les tokens
    handler = TokenQueueHandler()
    
    # Étape 4 : Lancer le Run en mode streaming avec l'assistant personnalisé
    stream = client.beta.threads.runs.stream(
        thread_id=thread.id,
        assistant_id="asst_Tzai3Ek76LoSaoBTASSYLIqF",
        instructions="",  # Vous pouvez ajouter des instructions spécifiques ici
        event_handler=handler,
    )
    
    # Lancer le streaming dans un thread séparé afin de ne pas bloquer
    def run_stream():
        stream.until_done()
    
    t = threading.Thread(target=run_stream, daemon=True)
    t.start()
    
    # Étape 5 : Yielder les tokens dès qu'ils sont disponibles dans la file
    while not handler.done or not handler.q.empty():
        try:
            token = handler.q.get(timeout=0.1)
            yield token
        except queue.Empty:
            pass
