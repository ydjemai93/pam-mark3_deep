# llm.py
import os
import json
import queue
import threading
import requests
import time

# Configuration API
openai_api_key = os.getenv("OPENAI_API_KEY")
API_BASE = "https://api.openai.com/v1"
beta_headers = {
    "Authorization": f"Bearer {openai_api_key}",
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"
}

#########################################
# Implémentation minimale des endpoints #
#########################################

class BetaThreads:
    @staticmethod
    def create():
        url = f"{API_BASE}/threads"
        resp = requests.post(url, headers=beta_headers, json={})
        resp.raise_for_status()
        return resp.json()  # Ex: {"id": "thread_id", ...}

    class Messages:
        @staticmethod
        def create(thread_id, role, content):
            url = f"{API_BASE}/threads/{thread_id}/messages"
            data = {"role": role, "content": content}
            resp = requests.post(url, headers=beta_headers, json=data)
            resp.raise_for_status()
            return resp.json()

    class Runs:
        @staticmethod
        def stream(thread_id, assistant_id, instructions, event_handler):
            url = f"{API_BASE}/threads/{thread_id}/runs"
            data = {
                "assistant_id": assistant_id,
                "instructions": instructions
            }
            resp = requests.post(url, headers=beta_headers, json=data, stream=True)
            resp.raise_for_status()
            return BetaRunStream(resp, event_handler)

class BetaRunStream:
    def __init__(self, response, event_handler):
        self.response = response
        self.event_handler = event_handler

    def until_done(self):
        # Supposons que la réponse est un flux de lignes JSON.
        for line in self.response.iter_lines(decode_unicode=True):
            if line:
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                event_type = event.get("event")
                data = event.get("data", {})
                if event_type == "textDelta":
                    # Créer un objet simple pour delta
                    delta = type("Delta", (object,), {"value": data.get("value", "")})
                    self.event_handler.on_text_delta(delta, {})
                elif event_type == "textCreated":
                    self.event_handler.on_text_created(data.get("text", ""))
                elif event_type == "runCompleted":
                    self.event_handler.on_run_completed()
                    break

#########################################
# Gestionnaire d'événements pour le Run #
#########################################

class AssistantEventHandler:
    def on_text_created(self, text):
        pass
    def on_text_delta(self, delta, snapshot):
        pass
    def on_tool_call_created(self, tool_call):
        pass
    def on_tool_call_delta(self, delta, snapshot):
        pass
    def on_run_completed(self):
        pass

class TokenQueueHandler(AssistantEventHandler):
    def __init__(self):
        self.q = queue.Queue()
        self.done = False

    def on_text_delta(self, delta, snapshot):
        self.q.put(delta.value)

    def on_text_created(self, text):
        self.q.put(text)
        self.done = True

    def on_run_completed(self):
        self.done = True

#########################################
# Fonction gpt4_stream utilisant l'Assistants API
#########################################

def gpt4_stream(messages):
    """
    Crée un thread de conversation, ajoute les messages,
    lance un Run en streaming via l'assistant personnalisé (ID fourni)
    et renvoie un générateur de tokens.
    """
    # Étape 1 : Créer un Thread pour la conversation
    thread_obj = BetaThreads.create()
    thread_id = thread_obj["id"]

    # Étape 2 : Ajouter chaque message au Thread
    for msg in messages:
        BetaThreads.Messages.create(thread_id, msg["role"], msg["content"])

    # Étape 3 : Créer un gestionnaire d'événements pour collecter les tokens
    handler = TokenQueueHandler()

    # Étape 4 : Lancer le Run en mode streaming avec l'assistant personnalisé
    stream = BetaThreads.Runs.stream(thread_id, "asst_Tzai3Ek76LoSaoBTASSYLIqF", "", handler)

    # Lancer le streaming dans un thread séparé pour ne pas bloquer
    def run_stream():
        stream.until_done()
    t = threading.Thread(target=run_stream, daemon=True)
    t.start()

    # Étape 5 : Yield les tokens dès qu'ils arrivent dans la file
    while not handler.done or not handler.q.empty():
        try:
            token = handler.q.get(timeout=0.1)
            yield token
        except queue.Empty:
            continue
