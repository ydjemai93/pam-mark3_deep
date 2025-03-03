# llm.py
import os
import queue
import threading
from openai import OpenAI

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def gpt4_stream(messages):
    """Génère un flux de tokens via l'API Assistants de OpenAI (version moderne)"""
    try:
        # Créer un thread avec l'historique de conversation
        thread = client.beta.threads.create(messages=messages)
        
        # Lancer l'exécution avec streaming
        with client.beta.threads.runs.stream(
            thread_id=thread.id,
            assistant_id="asst_Tzai3Ek76LoSaoBTASSYLIqF",
        ) as stream:
            for event in stream:
                if event.event == "thread.message.delta":
                    # Récupérer le delta de contenu
                    content_delta = event.data.delta.content[0].text
                    if content_delta.value:
                        yield content_delta.value
                        
    except Exception as e:
        logging.error(f"Erreur GPT-4: {e}")
        yield ""
