# twilio_server.py
import os
import json
import base64
import audioop
import logging

from flask import Flask, request
from flask_sock import Sock
import simple_websocket
from gevent.pywsgi import WSGIServer

from agent import StreamingAgent

logging.basicConfig(level=logging.INFO)

XML_MEDIA_STREAM = """
<Response>
    <!-- On active le streaming sur tracks="both" pour barge-in -->
    <Start>
        <Stream url="wss://{host}/audiostream" tracks="both"/>
    </Start>
    <Pause length="3600"/>
</Response>
"""

def create_app():
    app = Flask(__name__)
    sock = Sock(app)
    app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET", "secret")

    AGENT = StreamingAgent()

    @app.route("/call", methods=["POST"])
    def call():
        host = request.host
        return XML_MEDIA_STREAM.format(host=host)

    @sock.route("/audiostream", websocket=True)
    def audiostream(ws):
        session_id = AGENT.start_session(ws)
        logging.info(f"[Session {session_id}] Twilio WebSocket connected")

        try:
            while True:
                message = ws.receive()
                if not message:
                    break
                data = json.loads(message)

                if data["event"] == "start":
                    logging.info(f"[Session {session_id}] call start: {data['start']}")
                elif data["event"] == "media":
                    # chunk ulaw
                    chunk_ulaw = base64.b64decode(data["media"]["payload"])
                    # Convert ulaw -> PCM16
                    chunk_pcm = audioop.ulaw2lin(chunk_ulaw, 2)
                    # On envoie ce chunk à l'agent
                    AGENT.on_user_audio_chunk(session_id, chunk_pcm)
                elif data["event"] == "stop":
                    logging.info(f"[Session {session_id}] call ended by Twilio")
                    break
        except simple_websocket.ConnectionClosed:
            logging.info(f"[Session {session_id}] WS forcibly closed.")
        finally:
            AGENT.end_session(session_id)

        return ""

    return app
