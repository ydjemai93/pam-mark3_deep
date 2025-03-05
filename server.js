// server.js

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url"); // Pour parser l'URL et faire un routage minimal

// Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (accountSid && authToken) {
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log("Twilio client initialisé avec SID =", accountSid);
} else {
  console.warn("ATTENTION: TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN manquants. L'appel sortant échouera.");
}

// Deepgram
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// OpenAI
const OpenAI = require("openai");
const openai = new OpenAI();

// Paramètres
const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;

// WebSocket
const { server: WebSocketServer } = require("websocket");
const WebSocket = require("ws");

// TTS
const deepgramTTSWebsocketURL = process.env.DEEPGRAM_TTS_WS_URL ||
  "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";

// Timings
let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// -----------------------------------------------------------------------
// 1) Créer un serveur HTTP natif
// -----------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Routage minimal
  if (req.method === "GET" && pathname === "/") {
    // Endpoint de test simple
    console.log("GET /");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running.");
  }

  // Endpoint /ping pour tester un POST sans parsing
  if (req.method === "POST" && pathname === "/ping") {
    console.log("POST /ping");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }

  // Endpoint /twiml pour fournir un TwiML
  if (req.method === "POST" && pathname === "/twiml") {
    console.log("POST /twiml");
    try {
      const filePath = path.join(__dirname, "templates", "streams.xml");
      let streamsXML = fs.readFileSync(filePath, "utf8");

      // SERVER: nom de domaine config
      let serverUrl = process.env.SERVER || "localhost";
      // retirer http(s):// s'il existe
      serverUrl = serverUrl.replace(/^https?:\/\//, "");
      // remplacer <YOUR NGROK URL> par serverUrl
      streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(streamsXML);
    } catch (err) {
      console.error("Erreur /twiml:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error (twiml)");
    }
  }

  // Endpoint /outbound (POST) pour initier un appel
  if (req.method === "POST" && pathname === "/outbound") {
    console.log("POST /outbound -- route démarrée");
    let body = "";

    // Logs pour chaque chunk reçu
    req.on("data", (chunk) => {
      console.log("  /outbound: chunk =", chunk.toString());
      body += chunk;
    });

    req.on("end", async () => {
      console.log("  /outbound: end. body =", body);

      // Parser le JSON
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

      // Définir l'URL TwiML
      let domain = process.env.SERVER || "";
      if (!domain.startsWith("http")) domain = "https://" + domain;
      domain = domain.replace(/\/$/, "");
      const twimlUrl = `${domain}/twiml`;

      // Lancement de l'appel Twilio
      try {
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661"; // Par défaut, un numéro Twilio
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

    // Si jamais la requête a une erreur en cours de route
    req.on("error", (err) => {
      console.error("  /outbound: req error =>", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Request error" }));
    });

    return; // On quitte le handler, le reste se fait dans req.on('end')
  }

  // Sinon, 404
  console.log(`Route inconnue: ${req.method} ${pathname}`);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// -----------------------------------------------------------------------
// 2) Mettre en place le WebSocket pour Twilio Media Streams (/streams)
// -----------------------------------------------------------------------
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

// -----------------------------------------------------------------------
// 3) Classe MediaStream : gère la logique Twilio <-> Deepgram <-> GPT
// -----------------------------------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;

    // STT
    this.deepgram = setupDeepgram(this);
    // TTS
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

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
          console.log("twilio: other event =>", data.event);
      }
    }
  }

  close() {
    console.log("twilio: MediaStream closed");
  }
}

// -----------------------------------------------------------------------
// 4) Setup STT: Deepgram
// -----------------------------------------------------------------------
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-phonecall",
    language: "en",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
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
          llmStart = Date.now();
          promptLLM(mediaStream, utterance);
        } else {
          console.log("deepgram STT: final =>", transcript);
        }
      } else {
        console.log("deepgram STT: interim =>", transcript);
        if (speaking) {
          console.log("interrupt TTS => user speaking");
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
        console.log("deepgram STT: utteranceEnd =>", utterance);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
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

// -----------------------------------------------------------------------
// 5) Setup TTS: Deepgram
// -----------------------------------------------------------------------
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
      const testJson = JSON.parse(data);
      console.log("deepgram TTS => JSON msg:", testJson);
      return;
    } catch (err) {
      // c'est probablement de l'audio
    }

    if (firstByte) {
      const diff = Date.now() - ttsStart;
      console.log("deepgram TTS: time to first byte =", diff, "ms");
      firstByte = false;
      if (send_first_sentence_input_time) {
        console.log(
          "deepgram TTS: TTFB from end of sentence token =",
          Date.now() - send_first_sentence_input_time,
          "ms"
        );
      }
    }

    const payload = data.toString("base64");
    const msg = {
      event: "media",
      streamSid: streamSid,
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

// -----------------------------------------------------------------------
// 6) OpenAI LLM
// -----------------------------------------------------------------------
async function promptLLM(mediaStream, prompt) {
  speaking = true;
  let firstToken = true;

  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      { role: "assistant", content: "You are funny, everything is a joke to you." },
      { role: "user", content: prompt },
    ],
  });

  for await (const chunk of stream) {
    if (!speaking) break;
    if (firstToken) {
      const timeToFirstToken = Date.now() - llmStart;
      ttsStart = Date.now();
      console.log("openai LLM: time to first token =", timeToFirstToken, "ms");
      firstToken = false;
      firstByte = true;
    }
    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      process.stdout.write(chunkMessage);
      if (!send_first_sentence_input_time && hasEndingPunctuation(chunkMessage)) {
        send_first_sentence_input_time = Date.now();
      }
      mediaStream.deepgramTTSWebsocket.send(
        JSON.stringify({ type: "Speak", text: chunkMessage })
      );
    }
  }
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
}

function hasEndingPunctuation(str) {
  return [...str].some((char) => chars_to_check.includes(char));
}

// -----------------------------------------------------------------------
// 7) Lancer le serveur
// -----------------------------------------------------------------------
server.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
  console.log("Test endpoints:");
  console.log(" - GET  /                => Simple check");
  console.log(" - POST /ping            => Renvoie { message: pong }");
  console.log(" - POST /outbound        => Attend un body JSON { to: '+336...' }");
  console.log(" - POST /twiml           => Renvoie un TwiML streams.xml");
  console.log("WebSocket => /streams");
});
