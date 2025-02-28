# llm.py
import openai
import os

openai.api_key = os.getenv("OPENAI_API_KEY")

def gpt4_stream(messages):
    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=messages,
        stream=True,
        temperature=0.7
    )
    for chunk in response:
        if "choices" in chunk:
            delta = chunk["choices"][0]["delta"]
            if "content" in delta:
                yield delta["content"]
