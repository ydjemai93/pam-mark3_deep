// server.js

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
const WebSocket = require("ws");

// Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (accountSid && authToken) {
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log("Twilio client OK:", accountSid);
} else {
  console.warn("Twilio credentials missing => no outbound calls");
}

// Deepgram
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const deepgramTTSWebsocketURL =
  process.env.DEEPGRAM_TTS_WS_URL ||
  "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";

// OpenAI
const OpenAI = require("openai");
const openai = new OpenAI();

// systemMessage et initialAssistantMessage identiques
const systemMessage = `Tu es Pam, un agent téléphonique IA conçu pour démontrer les capacités de notre solution SaaS, qui permet de créer et de personnaliser des agents téléphoniques intelligents.

En tant que démo interactive, ton rôle est de montrer aux utilisateurs comment un agent IA peut gérer efficacement des tâches de secrétariat, de support client, de vente et d'assistance technique. Grâce à une intégration fluide avec divers outils professionnels, tu peux t’adapter aux besoins spécifiques de chaque entreprise.

Ton objectif est d’adopter une voix naturelle et humaine tout en suivant ces étapes :

1. Saluer poliment l’utilisateur et reconnaître la soumission du formulaire.
2. Présenter tes capacités et expliquer en quoi un agent IA peut être utile.
3. Fournir des exemples concrets ou des scénarios d’utilisation pour illustrer ton efficacité.
4. Résumer et inviter l’utilisateur à poser des questions ou à faire une demande spécifique.

La conversation doit être fluide, professionnelle et engageante. Adapte-toi aux réponses de l’utilisateur et évite de réciter ces instructions de manière mécanique.
`;
const initialAssistantMessage = `Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire sur notre site web.
Je suis là pour te faire une courte démonstration de ce que je sais faire : gestion de secrétariat, support client, assistance à la vente et aide technique.
Comment puis-je t’aider aujourd’hui ?`;

// Variables
const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;
let conversation = [];

let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

//------------------------------------------
// Serveur HTTP
//------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running.");
  }

  if (req.method === "POST" && pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }

  if (req.method === "POST" && pathname === "/twiml") {
    try {
      const filePath = path.join(__dirname, "templates", "streams.xml");
      let streamsXML = fs.readFileSync(filePath, "utf8");
      let serverUrl = process.env.SERVER || "localhost";
      serverUrl = serverUrl.replace(/^https?:\/\//, "");
      streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(streamsXML);
    } catch (err) {
      console.error("Error reading streams.xml:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error (twiml)");
    }
  }

  if (req.method === "POST" && pathname === "/outbound") {
    console.log("POST /outbound");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      const toNumber = parsed.to;
      if (!toNumber) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "'to' missing" }));
      }
      if (!twilioClient) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Twilio not configured" }));
      }
      let domain = process.env.SERVER || "";
      if (!domain.startsWith("http")) domain = "https://" + domain;
      domain = domain.replace(/\/$/, "");
      const twimlUrl = `${domain}/twiml`;

      try {
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661";
        console.log("calling =>", toNumber, "from=>", fromNumber, "url=>", twimlUrl);
        const call = await twilioClient.calls.create({
          to: toNumber,
          from: fromNumber,
          url: twimlUrl,
          method: "POST",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, callSid: call.sid }));
      } catch (err) {
        console.error("Twilio error =>", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

//------------------------------------------
// WebSocket /streams
//------------------------------------------
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

wsServer.on("request", (request) => {
  if (request.resourceURL.pathname === "/streams") {
    console.log("/streams => accepted");
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("/streams => rejected");
  }
});

//------------------------------------------
// Classe MediaStream
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;

    // Reset conversation
    conversation = [];

    // Ajouter un message assistant initial
    conversation.push({
      role: "assistant",
      content: initialAssistantMessage,
    });

    // Créer STT et TTS
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

    // Important: Attendre l'ouverture de la WebSocket TTS
    this.deepgramTTSWebsocket.once("open", () => {
      console.log("TTS websocket is open => speak initial message");
      this.speak(initialAssistantMessage);
    });

    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
  }

  processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          console.log("twilio: connected");
          break;
        case "start":
          console.log("twilio: start =>", data);
          break;
        case "media":
          if (!this.hasSeenMedia) {
            console.log("twilio: first media =>", data);
            this.hasSeenMedia = true;
          }
          if (!streamSid) {
            streamSid = data.streamSid;
          }
          if (data.media.track === "inbound") {
            const rawAudio = Buffer.from(data.media.payload, "base64");
            this.deepgram.send(rawAudio);
          }
          break;
        case "close":
          console.log("twilio: close =>", data);
          this.close();
          break;
        default:
          break;
      }
    }
  }

  speak(text) {
    speaking = true;
    firstByte = true;
    ttsStart = Date.now();
    send_first_sentence_input_time = null;

    // On envoie le "Speak"
    this.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text }));
    // Flush
    this.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
  }

  close() {
    console.log("twilio: MediaStream closed");
  }
}

//------------------------------------------
// Setup Deepgram STT
//------------------------------------------
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-general",
    language: "fr",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => dgLive.keepAlive(), 10000);

  dgLive.addListener(LiveTranscriptionEvents.Open, () => {
    console.log("deepgram STT => connected");

    dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (!transcript) return;

      if (data.is_final) {
        is_finals.push(transcript);
        if (data.speech_final) {
          const utterance = is_finals.join(" ");
          is_finals = [];
          console.log("deepgram STT => speech_final =>", utterance);

          speaking = false;
          conversation.push({ role: "user", content: utterance });
          callGPT(mediaStream);
        } else {
          console.log("deepgram STT => final =>", transcript);
        }
      } else {
        console.log("deepgram STT => interim =>", transcript);
        if (speaking) {
          console.log("interrupt TTS => user is speaking");
          mediaStream.connection.sendUTF(JSON.stringify({ event: "clear", streamSid }));
          mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Clear" }));
          speaking = false;
        }
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (is_finals.length) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log("deepgram STT => utteranceEnd =>", utterance);

        speaking = false;
        conversation.push({ role: "user", content: utterance });
        callGPT(mediaStream);
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.Close, () => {
      console.log("deepgram STT => disconnected");
      clearInterval(keepAlive);
      dgLive.requestClose();
    });

    dgLive.addListener(LiveTranscriptionEvents.Error, (err) => {
      console.error("deepgram STT => error", err);
    });
  });
  return dgLive;
}

//------------------------------------------
// Setup TTS
//------------------------------------------
function setupDeepgramTTS(mediaStream) {
  const ws = new WebSocket(deepgramTTSWebsocketURL, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });
  ws.on("open", () => console.log("deepgram TTS => connected"));
  ws.on("message", (data) => {
    if (!speaking) return;
    try {
      const maybeJson = JSON.parse(data);
      console.log("deepgram TTS => JSON msg:", maybeJson);
      return;
    } catch (err) { /* c'est de l'audio */ }

    if (firstByte) {
      const diff = Date.now() - ttsStart;
      console.log("deepgram TTS => time to first byte =", diff, "ms");
      firstByte = false;
    }
    const payload = data.toString("base64");
    const msg = {
      event: "media",
      streamSid,
      media: { payload },
    };
    mediaStream.connection.sendUTF(JSON.stringify(msg));
  });
  ws.on("close", () => console.log("deepgram TTS => disconnected"));
  ws.on("error", (err) => console.log("deepgram TTS => error", err));
  return ws;
}

//------------------------------------------
// callGPT => streaming GPT
//------------------------------------------
async function callGPT(mediaStream) {
  console.log("callGPT => conversation so far:", conversation);
  speaking = true;
  let firstToken = true;
  llmStart = Date.now();

  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      { role: "system", content: systemMessage },
      ...conversation,
    ],
  });

  let assistantReply = "";

  for await (const chunk of stream) {
    if (!speaking) break;
    if (firstToken) {
      firstToken = false;
      firstByte = true;
      ttsStart = Date.now();
      const t = Date.now() - llmStart;
      console.log("GPT => time to first token =", t, "ms");
    }
    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      assistantReply += chunkMessage;
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text: chunkMessage }));
    }
  }

  // Flush
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
  // Ajouter la réplique
  if (assistantReply.trim()) {
    conversation.push({ role: "assistant", content: assistantReply });
  }
}

//------------------------------------------
// Lancement du serveur
//------------------------------------------
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
