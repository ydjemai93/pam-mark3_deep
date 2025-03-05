// server.js

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ---------- OpenAI ----------
const OpenAI = require("openai");
const openai = new OpenAI(); // la clé est lue depuis process.env.OPENAI_API_KEY
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "asst_votreAssistantID";

// ---------- Twilio ----------
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

// ---------- Deepgram ----------
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// ---------- WebSocket (pour Twilio Media Streams) ----------
const { server: WebSocketServer } = require("websocket");
const WebSocket = require("ws");

// ---------- Variables & Config ----------
const PORT = process.env.PORT || 8080;
const server = http.createServer(requestHandler);

const deepgramTTSWebsocketURL = process.env.DEEPGRAM_TTS_WS_URL ||
  "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";

let streamSid = "";
let keepAlive;
let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

/**
 * ROUTEUR MINIMAL
 */
function requestHandler(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // GET / => test
  if (req.method === "GET" && pathname === "/") {
    console.log("GET /");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running. (OpenAI Assistant + Twilio + Deepgram)");
  }

  // POST /ping => petit test sans body
  if (req.method === "POST" && pathname === "/ping") {
    console.log("POST /ping");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }

  // POST /twiml => renvoyer le streams.xml
  if (req.method === "POST" && pathname === "/twiml") {
    console.log("POST /twiml");
    return handleTwiml(res);
  }

  // POST /outbound => initier un appel sortant
  if (req.method === "POST" && pathname === "/outbound") {
    console.log("POST /outbound");
    return handleOutbound(req, res);
  }

  // Sinon, 404
  console.log(`Route non gérée: ${req.method} ${pathname}`);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

/**
 * 1) Lecture du streams.xml, renvoi en XML
 */
function handleTwiml(res) {
  try {
    const filePath = path.join(__dirname, "templates", "streams.xml");
    let streamsXML = fs.readFileSync(filePath, "utf8");

    let serverUrl = process.env.SERVER || "localhost";
    // enlever http:// ou https:// s'ils sont présents
    serverUrl = serverUrl.replace(/^https?:\/\//, "");
    // remplacer <YOUR NGROK URL> dans streams.xml
    streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(streamsXML);
    console.log("/twiml => streams.xml envoyé");
  } catch (err) {
    console.error("Erreur /twiml:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error (twiml)");
  }
}

/**
 * 2) handleOutbound: initier un appel sortant
 */
function handleOutbound(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    console.log(" /outbound => chunk =", chunk.toString());
    body += chunk;
  });
  req.on("end", async () => {
    console.log(" /outbound => end. body =", body);
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      console.error(" /outbound => JSON parse error:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
    }

    const toNumber = data.to;
    if (!toNumber) {
      console.error(" /outbound => 'to' manquant");
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Missing 'to' param" }));
    }

    if (!twilioClient) {
      console.error(" /outbound => Twilio client non init");
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Twilio not configured" }));
    }

    // Construire URL /twiml complet
    let domain = process.env.SERVER || "localhost";
    if (!domain.startsWith("http")) domain = "https://" + domain;
    domain = domain.replace(/\/$/, "");
    const twimlUrl = `${domain}/twiml`;

    try {
      const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661"; // ex. par défaut
      console.log(" /outbound => calls.create:", { from: fromNumber, to: toNumber, url: twimlUrl });
      const call = await twilioClient.calls.create({
        from: fromNumber,
        to: toNumber,
        url: twimlUrl,
        method: "POST",
      });

      console.log(" /outbound => Appel Twilio OK. SID=", call.sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, callSid: call.sid }));
    } catch (err) {
      console.error(" /outbound => Erreur Twilio:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
  req.on("error", (err) => {
    console.error(" /outbound => req error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: false, error: "Request error" }));
  });
}

/**
 * 3) Mise en place WebSocket => /streams (Twilio Media Streams)
 */
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

wsServer.on("request", function (request) {
  if (request.resourceURL.pathname === "/streams") {
    console.log("/streams => connexion acceptée");
    let connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("/streams => connexion rejetée (URL invalide)");
  }
});

/**
 * Classe MediaStream : chaque appel aura son propre thread
 */
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;
    this.threadId = null; // ID de thread dans OpenAI

    // Préparer STT & TTS
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
  }

  async processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);

      switch (data.event) {
        case "connected":
          console.log("twilio => connected:", data);
          break;
        case "start":
          console.log("twilio => start:", data);
          break;
        case "media":
          if (!this.hasSeenMedia) {
            console.log("twilio => first media event:", data);
            this.hasSeenMedia = true;
            // A la toute première réception audio, on crée le thread dans l'assistant
            await this.createAssistantThread();
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
          console.log("twilio => close:", data);
          this.close();
          break;
        default:
          // mark, etc.
          break;
      }
    }
  }

  close() {
    console.log("twilio => MediaStream closed.");
  }

  /**
   * Création du thread dans OpenAI Assistants
   */
  async createAssistantThread() {
    if (!this.threadId) {
      console.log("createAssistantThread => Creating new thread for assistant ID =", ASSISTANT_ID);
      try {
        const newThread = await openai.beta.chat.assistants.createThread({
          assistant: ASSISTANT_ID,
          title: "Voice Call " + new Date().toISOString(),
        });
        this.threadId = newThread.id;
        console.log("createAssistantThread => threadId =", this.threadId);
      } catch (err) {
        console.error("createAssistantThread => Error creating thread:", err);
      }
    }
  }
}

/**
 * 4) Setup du STT Deepgram
 */
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
    console.log("deepgram STT => connected");

    dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (!transcript) return;

      if (data.is_final) {
        is_finals.push(transcript);
        if (data.speech_final) {
          const utterance = is_finals.join(" ");
          is_finals = [];
          console.log("deepgram STT => speech final:", utterance);
          llmStart = Date.now();
          promptLLM(mediaStream, utterance);
        } else {
          console.log("deepgram STT => final:", transcript);
        }
      } else {
        console.log("deepgram STT => interim:", transcript);
        if (speaking) {
          console.log("deepgram STT => user speaking => on coupe TTS");
          mediaStream.connection.sendUTF(JSON.stringify({ event: "clear", streamSid }));
          mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Clear" }));
          speaking = false;
        }
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (is_finals.length > 0) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log("deepgram STT => utteranceEnd =>", utterance);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.Close, () => {
      console.log("deepgram STT => disconnected");
      clearInterval(keepAlive);
      dgLive.requestClose();
    });

    dgLive.addListener(LiveTranscriptionEvents.Error, (err) => {
      console.error("deepgram STT => error:", err);
    });

    dgLive.addListener(LiveTranscriptionEvents.Warning, (warn) => {
      console.warn("deepgram STT => warning:", warn);
    });
  });

  return dgLive;
}

/**
 * 5) Setup du TTS Deepgram
 */
function setupDeepgramTTS(mediaStream) {
  const ws = new WebSocket(deepgramTTSWebsocketURL, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on("open", () => {
    console.log("deepgram TTS => connected");
  });

  ws.on("message", (data) => {
    if (!speaking) return;
    try {
      const maybeJson = JSON.parse(data);
      console.log("deepgram TTS => JSON msg:", maybeJson);
      return;
    } catch (err) {
      // sinon c'est l'audio
    }

    if (firstByte) {
      const diff = Date.now() - ttsStart;
      console.log("deepgram TTS => time to first byte =", diff, "ms");
      firstByte = false;
      if (send_first_sentence_input_time) {
        console.log(
          "deepgram TTS => TTFB from endOfSentence token =",
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
    console.log("deepgram TTS => disconnected");
  });

  ws.on("error", (err) => {
    console.error("deepgram TTS => error:", err);
  });

  return ws;
}

/**
 * 6) promptLLM => appeler l'assistant OpenAI via un thread
 */
async function promptLLM(mediaStream, userPrompt) {
  // On suppose que createAssistantThread a été fait => mediaStream.threadId
  if (!mediaStream.threadId) {
    console.warn("promptLLM => Pas de threadId => on tente d'en créer un à la volée");
    await mediaStream.createAssistantThread();
    if (!mediaStream.threadId) {
      console.error("Impossible de créer un thread => on ne peut pas continuer");
      return;
    }
  }

  speaking = true;
  let firstToken = true;

  console.log("promptLLM => Envoi userPrompt au thread", mediaStream.threadId, ":", userPrompt);
  try {
    const stream = openai.beta.chat.assistants.streamMessage({
      assistant: ASSISTANT_ID,
      thread: mediaStream.threadId, // On réutilise le thread pour conserver le contexte
      stream: true,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    for await (const chunk of stream) {
      if (!speaking) break;
      // chunk.choices[0].delta.content
      const chunkMessage = chunk.choices[0]?.delta?.content;
      if (chunkMessage) {
        if (firstToken) {
          const timeToFirstToken = Date.now() - llmStart;
          ttsStart = Date.now();
          console.log("openai LLM => timeToFirstToken =", timeToFirstToken, "ms");
          firstToken = false;
          firstByte = true;
        }
        process.stdout.write(chunkMessage);
        // TTS
        if (!send_first_sentence_input_time && containsAnyChars(chunkMessage)) {
          send_first_sentence_input_time = Date.now();
        }
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text: chunkMessage }));
      }
    }
    // Flush final
    mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
  } catch (err) {
    console.error("promptLLM => erreur pendant streamMessage:", err);
  }
}

/**
 * Petite fonction utilitaire
 */
function containsAnyChars(str) {
  return [...str].some((char) => chars_to_check.includes(char));
}

/**
 * 7) Lancement du serveur HTTP
 */
server.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
  console.log("Test endpoints:");
  console.log(" - GET  /         => renvoie un texte simple");
  console.log(" - POST /ping     => renvoie {message: 'pong'}");
  console.log(" - POST /outbound => Attend body JSON { to: '+...' } pour appeler Twilio");
  console.log(" - POST /twiml    => renvoie streams.xml pour le streaming Twilio -> WebSocket /streams");
  console.log("WebSocket => /streams (Twilio Media Streams).");
});
