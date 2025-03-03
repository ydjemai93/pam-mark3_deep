# llm.py
import os
import logging
from openai import OpenAI

# Configuration du client OpenAI
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def gpt4_stream(messages):
    """
    Génère un flux de réponse GPT-4 en utilisant l'API ChatCompletion
    Version simplifiée et compatible avec openai>=1.12.0
    """
    try:
        response = client.chat.completions.create(
            model="gpt-4",
            messages=messages,
            stream=True,
            temperature=0.7
        )

        for chunk in response:
            content = chunk.choices[0].delta.content
            if content:
                yield content

    except Exception as e:
        logging.error(f"Erreur GPT-4: {e}")
        yield ""
