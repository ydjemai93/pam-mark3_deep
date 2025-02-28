# main.py
import os
from twilio_server import create_app

# Crée l'app Flask
app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)

