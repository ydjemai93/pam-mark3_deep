// server.js

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
const WebSocket = require("ws");

// ----------------------------------
// 1) Twilio (REST) - pour /outbound
// ----------------------------------
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (accountSid && authToken) {
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log("Twilio client initialisé avec SID =", accountSid);
} else {
  console.warn("TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN manquants. L'appel sortant échouera.");
}

// ----------------------------------
// 2) Deepgram (STT & TTS)
// ----------------------------------
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const deepgramTTSWebsocketURL =
  process.env.DEEPGRAM_TTS_WS_URL ||
  "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";

// ----------------------------------
// 3) OpenAI
// ----------------------------------
const OpenAI = require("openai");
const openai = new OpenAI();

// =====================================
// Ajout d'un "systemMessage" + message assistant initial
// =====================================

// -- Le message système (instructions pour GPT, non prononcé) :
const systemMessage = `
You are Pam, an AI phone agent designed to present a demo to users who have filled out a form on our website. 
You are capable of handling secretarial requests, customer support, sales, and technical support. 
You can utilize various tools to personalize and integrate into professional contexts. 
Your goal is to sound natural and human-like, while following these steps:

1. Greet politely and acknowledge the form submission.
2. Demonstrate capabilities (secretarial, customer support, sales, technical).
3. Provide examples or scenarios to show how you can help.
4. Summarize and ask if the user has any questions or requests.

Keep the conversation friendly and professional. Adapt to the user's input and avoid merely reciting these instructions out loud.
`;

// -- Le message assistant initial qui sera lu par TTS dès qu'on démarre la conversation
// (ex. quand Twilio envoie "start" event).
const initialAssistantMessage = `Hello! This is Pam, your AI phone agent. Thank you for submitting the form on our website. 
I'm here to give you a quick demo of my capabilities, including secretarial tasks, customer support, sales assistance, and technical help. 
How can I assist you today?`;

// ----------------------------------
// Variables globales (pour démo single-call)
// ----------------------------------
const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;

// Ce tableau va stocker l'historique des messages { role: 'user' | 'assistant', content: string }
let conversation = [];

// Contrôle TTS
let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// ----------------------------------
// 4) Serveur HTTP (pour /twiml, /outbound, etc.)
// ----------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // GET / => test simple
  if (req.method === "GET" && pathname === "/") {
    console.log("GET /");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running (GET /).");
  }

  // POST /ping => test d'appel POST minimal
  if (req.method === "POST" && pathname === "/ping") {
    console.log("POST /ping");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }

  // POST /twiml => renvoie le TwiML (streams.xml) utilisé par Twilio
  if (req.method === "POST" && pathname === "/twiml") {
    console.log("POST /twiml");
    try {
      const filePath = path.join(__dirname, "templates", "streams.xml");
      let streamsXML = fs.readFileSync(filePath, "utf8");

      let serverUrl = process.env.SERVER || "localhost";
      serverUrl = serverUrl.replace(/^https?:\/\//, ""); // retirer http(s)://
      streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(streamsXML);
    } catch (err) {
      console.error("Erreur /twiml:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error (twiml)");
    }
  }

  // POST /outbound => initier un appel sortant via Twilio
  if (req.method === "POST" && pathname === "/outbound") {
    console.log("POST /outbound -- route démarrée");
    let body = "";

    req.on("data", (chunk) => {
      console.log("  /outbound: chunk =", chunk.toString());
      body += chunk;
    });

    req.on("end", async () => {
      console.log("  /outbound: end. body =", body);

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        console.error("  /outbound: JSON parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "invalid JSON" }));
      }

      const toNumber = parsed.to;
      if (!toNumber) {
        console.error("  /outbound: 'to' manquant", parsed);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "Missing 'to' parameter" }));
      }
      if (!twilioClient) {
        console.error("  /outbound: Twilio client non initialisé.");
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: "Twilio not configured" }));
      }

      // URL TwiML
      let domain = process.env.SERVER || "";
      if (!domain.startsWith("http")) domain = "https://" + domain;
      domain = domain.replace(/\/$/, "");
      const twimlUrl = `${domain}/twiml`;

      try {
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661";
        console.log("  /outbound: calls.create => to:", toNumber, "from:", fromNumber, "url:", twimlUrl);

        const call = await twilioClient.calls.create({
          to: toNumber,
          from: fromNumber,
          url: twimlUrl,
          method: "POST",
        });

        console.log("  /outbound: Appel Twilio OK. SID =", call.sid);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, callSid: call.sid }));
      } catch (err) {
        console.error("  /outbound: Twilio error =>", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });

    req.on("error", (err) => {
      console.error("  /outbound: req error =>", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Request error" }));
    });

    return;
  }

  // Sinon 404
  console.log(`Route inconnue: ${req.method} ${pathname}`);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// ----------------------------------
// 5) WebSocketServer => /streams
// ----------------------------------
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

wsServer.on("request", function (request) {
  if (request.resourceURL.pathname === "/streams") {
    console.log("/streams: connexion acceptée");
    let connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("/streams: connexion rejetée (URL invalide)");
  }
});

// ----------------------------------
// 6) Classe MediaStream
// ----------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;

    // Réinitialiser la conversation à chaque nouvel appel:
    conversation = [];

    // 1) On ajoute un message assistant initial, qu'on va prononcer tout de suite
    conversation.push({
      role: "assistant",
      content: initialAssistantMessage,
    });

    // 2) STT & TTS
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

    // 3) Envoyer la première phrase
    this.speak(initialAssistantMessage);

    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
  }

  processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          console.log("twilio: connected =>", data);
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
          // mark, etc.
          // console.log("twilio: other event =>", data);
          break;
      }
    }
  }

  speak(text) {
    // Envoyer le texte au TTS WebSocket
    // Indique qu'on est en train de parler
    speaking = true;
    firstByte = true;
    ttsStart = Date.now();
    send_first_sentence_input_time = null;

    // On envoie le chunk "text" (en 1 bloc) => Deepgram TTS
    this.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text }));
    // Puis "Flush"
    this.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
  }

  close() {
    console.log("twilio: MediaStream closed");
  }
}

// ----------------------------------
// 7) Deepgram STT
// ----------------------------------
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-phonecall",
    language: "en",
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
  keepAlive = setInterval(() => {
    dgLive.keepAlive();
  }, 10000);

  dgLive.addListener(LiveTranscriptionEvents.Open, () => {
    console.log("deepgram STT: connected");

    dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (!transcript) return;

      if (data.is_final) {
        is_finals.push(transcript);
        if (data.speech_final) {
          const utterance = is_finals.join(" ");
          is_finals = [];
          console.log("deepgram STT: speech final =>", utterance);
          // L'utilisateur a parlé => on arrête de parler
          speaking = false;

          // Ajouter ce message user à la conversation
          conversation.push({ role: "user", content: utterance });

          // Appeler GPT
          callGPT(mediaStream);
        } else {
          console.log("deepgram STT: final =>", transcript);
        }
      } else {
        console.log("deepgram STT: interim =>", transcript);
        // Couper la parole si l'agent parlait
        if (speaking) {
          console.log("interrupt TTS => user speaking");
          mediaStream.connection.sendUTF(JSON.stringify({ event: "clear", streamSid }));
          mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Clear" }));
          speaking = false;
        }
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
      // Au cas où
      if (is_finals.length) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log("deepgram STT: utteranceEnd =>", utterance);
        speaking = false;
        conversation.push({ role: "user", content: utterance });
        callGPT(mediaStream);
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.Close, () => {
      console.log("deepgram STT: disconnected");
      clearInterval(keepAlive);
      dgLive.requestClose();
    });

    dgLive.addListener(LiveTranscriptionEvents.Error, (err) => {
      console.error("deepgram STT error =>", err);
    });

    dgLive.addListener(LiveTranscriptionEvents.Warning, (warn) => {
      console.warn("deepgram STT warn =>", warn);
    });
  });

  return dgLive;
}

// ----------------------------------
// 8) Deepgram TTS
// ----------------------------------
function setupDeepgramTTS(mediaStream) {
  const ws = new WebSocket(deepgramTTSWebsocketURL, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  ws.on("open", () => {
    console.log("deepgram TTS: connected");
  });

  ws.on("message", (data) => {
    if (!speaking) return;
    try {
      const maybeJson = JSON.parse(data);
      console.log("deepgram TTS => JSON msg:", maybeJson);
      return;
    } catch (err) {
      // c'est probablement de l'audio
    }

    if (firstByte) {
      const diff = Date.now() - ttsStart;
      console.log("deepgram TTS: time to first byte =", diff, "ms");
      firstByte = false;
      if (send_first_sentence_input_time) {
        console.log("deepgram TTS: TTFB from end of sentence token =", Date.now() - send_first_sentence_input_time, "ms");
      }
    }

    const payload = data.toString("base64");
    const msg = {
      event: "media",
      streamSid,
      media: { payload },
    };
    mediaStream.connection.sendUTF(JSON.stringify(msg));
  });

  ws.on("close", () => {
    console.log("deepgram TTS: disconnected");
  });

  ws.on("error", (err) => {
    console.error("deepgram TTS: error =>", err);
  });

  return ws;
}

// ----------------------------------
// 9) Appel GPT (multi-tours) => promptLLM
// ----------------------------------
async function callGPT(mediaStream) {
  // On va préparer un "assistant" en streaming
  console.log("\ncallGPT: conversation =", conversation);

  // On redémarre speaking
  speaking = true;
  let firstToken = true;
  llmStart = Date.now();

  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      { role: "system", content: systemMessage },
      // On empile tout l'historique (assistant + user)
      ...conversation,
    ],
  });

  // On va accumuler la réponse en string pour la stocker dans conversation
  let assistantReply = "";

  for await (const chunk of stream) {
    if (!speaking) break; // En cas d'interruption

    if (firstToken) {
      const timeToFirstToken = Date.now() - llmStart;
      console.log("openai LLM: time to first token =", timeToFirstToken, "ms");
      firstToken = false;
      firstByte = true;
      ttsStart = Date.now();
    }
    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      assistantReply += chunkMessage;
      if (!send_first_sentence_input_time && containsAnyChars(chunkMessage)) {
        send_first_sentence_input_time = Date.now();
      }
      // On envoie au TTS en temps réel
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text: chunkMessage }));
    }
  }

  // Flush final
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));

  // Ajouter dans la conversation
  if (assistantReply.trim()) {
    conversation.push({ role: "assistant", content: assistantReply });
  }
}

// Petit util pour détecter ponctuation
function containsAnyChars(str) {
  return [...str].some((char) => chars_to_check.includes(char));
}

// ----------------------------------
// 10) Lancement du serveur
// ----------------------------------
server.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
  console.log("Test endpoints:");
  console.log(" - GET  /         => Simple check");
  console.log(" - POST /ping     => Renvoie { message: pong }");
  console.log(" - POST /outbound => Attend un body JSON { to: '+336...' }");
  console.log(" - POST /twiml    => Renvoie le fichier streams.xml");
  console.log("WebSocket => /streams");
});
