import uuid
import logging
import threading

from stt_deepgram import DeepgramStreamingSTT
from llm import gpt4_stream
from tts import ElevenLabsStreamer

class StreamingAgent:
    def __init__(self):
        self.sessions = {}

    def start_session(self, ws):
        session_id = str(uuid.uuid4())
        sess = {"ws": ws, "speaking": False, "interrupt": False, "conversation": []}
        sess["tts"] = ElevenLabsStreamer(lambda pcm: self.send_audio_chunk(session_id, pcm))
        sess["stt"] = DeepgramStreamingSTT(lambda text: None, lambda text: self.on_stt_final(session_id, text))
        self.sessions[session_id] = sess
        return session_id

    def on_stt_final(self, session_id, text):
        sess = self.sessions.get(session_id)
        if not sess or not text.strip():
            return
        sess["conversation"].append({"role": "user", "content": text})

        def run_gpt():
            sess["speaking"] = True
            partial_response = "".join(gpt4_stream(sess["conversation"]))
            sess["tts"].stream_text(partial_response)
            sess["speaking"] = False

        threading.Thread(target=run_gpt, daemon=True).start()

    def send_audio_chunk(self, session_id, pcm_data):
        sess = self.sessions.get(session_id)
        if sess:
            ws = sess["ws"]
            ws.send({"event": "media", "media": {"payload": pcm_data}})
