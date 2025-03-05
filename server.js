// server.js

// ------------------------------
// 1) Modules & Variables globales
// ------------------------------
const fs = require("fs");
const http = require("http");
const path = require("path");
require("dotenv").config();

// WebSocket
const WebSocket = require("ws");
const { server: WebSocketServer } = require("websocket");

// Twilio
const HttpDispatcher = require("httpdispatcher");
const dispatcher = new HttpDispatcher();
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_NUMBER;
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
const HTTP_SERVER = http.createServer(handleRequest);
let streamSid = "";
let keepAlive;

// Deepgram TTS WebSocket
const deepgramTTSWebsocketURL = process.env.DEEPGRAM_TTS_WS_URL ||
  "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";

// Timings
let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// ------------------------------
// 2) Fonctions utilitaires
// ------------------------------

function handleRequest(req, res) {
  try {
    dispatcher.dispatch(req, res);
  } catch (err) {
    console.error("Erreur dans handleRequest:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

function containsAnyChars(str) {
  let strArray = Array.from(str);
  return strArray.some((char) => chars_to_check.includes(char));
}

// ------------------------------
// 3) Endpoints
// ------------------------------

// a) Endpoint de test /ping
dispatcher.onPost("/ping", (req, res) => {
  console.log("POST /ping -- endpoint de test");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "pong" }));
});

// b) Endpoint TwiML (/twiml) pour appels entrants ET pour le callback des appels sortants
dispatcher.onPost("/twiml", (req, res) => {
  console.log("POST /twiml");
  const filePath = path.join(__dirname, "templates", "streams.xml");
  try {
    let streamsXML = fs.readFileSync(filePath, "utf8");
    // SERVER: domaine Railway ou autre
    let serverUrl = process.env.SERVER || "localhost";
    serverUrl = serverUrl.replace(/^https?:\/\//, ""); // retirer http(s):// s'il existe

    // Remplace <YOUR NGROK URL> par le domaine
    streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

    res.writeHead(200, {
      "Content-Type": "text/xml",
      "Content-Length": Buffer.byteLength(streamsXML),
    });
    res.end(streamsXML);
    console.log("Réponse XML TwiML envoyée.");
  } catch (err) {
    console.error("Erreur lors de la lecture de streams.xml:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

// c) Endpoint /outbound pour initier un appel sortant
dispatcher.onPost("/outbound", (req, res) => {
  console.log("POST /outbound -- début de la route");
  
  // Logs pour la lecture du body
  let body = "";
  req.on("data", (chunk) => {
    console.log("  /outbound: Reçu un chunk de data =", chunk.toString());
    body += chunk;
  });

  req.on("end", async () => {
    console.log("  /outbound: Reçu l'événement 'end'. body =", body);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      console.error("  /outbound: Erreur de parsing JSON:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Invalid JSON body" }));
    }

    if (!parsed || !parsed.to) {
      console.error("  /outbound: 'to' manquant dans le body:", parsed);
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Missing 'to' field" }));
    }

    if (!twilioClient) {
      console.error("  /outbound: Twilio client non initialisé (SID/TOKEN manquants ?)");
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "Twilio client not configured" }));
    }

    const toNumber = parsed.to;
    const fromNumber = twilioFromNumber;
    console.log(`  /outbound: to=${toNumber}, from=${fromNumber}`);

    // URL TwiML à appeler lorsque l'appel est décroché
    let domain = process.env.SERVER || "";
    if (!domain.startsWith("http")) {
      domain = "https://" + domain;
    }
    domain = domain.replace(/\/$/, ""); // enlever trailing slash
    const twimlUrl = `${domain}/twiml`;

    console.log("  /outbound: Appel Twilio -> calls.create()", {
      to: toNumber,
      from: fromNumber,
      url: twimlUrl,
      method: "POST",
    });

    try {
      const call = await twilioClient.calls.create({
        to: toNumber,
        from: fromNumber,
        url: twimlUrl,
        method: "POST",
      });

      console.log("  /outbound: Appel Twilio OK. call SID =", call.sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, callSid: call.sid }));
    } catch (error) {
      console.error("  /outbound: Erreur lors de l'initiation de l'appel Twilio:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  });

  req.on("error", (err) => {
    console.error("  /outbound: Erreur sur la requête HTTP:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "HTTP request error" }));
  });
});

// ------------------------------
// 4) WebSocket /streams (Twilio Media Streams)
// ------------------------------
const mediaws = new WebSocketServer({
  httpServer: HTTP_SERVER,
  autoAcceptConnections: false,
});

mediaws.on("request", function (request) {
  if (request.resourceURL.pathname === "/streams") {
    let connection = request.accept();
    console.log("twilio: Connection accepted on /streams");
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("twilio: Connection rejected, invalid URL:", request.resourceURL.pathname);
  }
});

// ------------------------------
// 5) Classe MediaStream : gère le flux Twilio <-> Deepgram <-> OpenAI
// ------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;
    this.messages = [];

    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
  }

  processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          console.log("twilio: Connected event received:", data);
          break;
        case "start":
          console.log("twilio: Start event received:", data);
          break;
        case "media":
          if (!this.hasSeenMedia) {
            console.log("twilio: First media event:", data);
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
        case "mark":
          console.log("twilio: Mark event:", data);
          break;
        case "close":
          console.log("twilio: Close event:", data);
          this.close();
          break;
        default:
          break;
      }
    } else {
      console.log("twilio: binary message received, ignored");
    }
  }

  close() {
    console.log("twilio: MediaStream closed");
  }
}

// ------------------------------
// 6) Deepgram & OpenAI
// ------------------------------
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
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
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (!transcript) return;

      if (data.is_final) {
        is_finals.push(transcript);
        if (data.speech_final) {
          const utterance = is_finals.join(" ");
          is_finals = [];
          console.log(`deepgram STT: [Speech Final] ${utterance}`);
          llmStart = Date.now();
          promptLLM(mediaStream, utterance);
        } else {
          console.log(`deepgram STT: [Is Final] ${transcript}`);
        }
      } else {
        console.log(`deepgram STT: [Interim] ${transcript}`);
        // Si l'agent parlait, on le coupe
        if (speaking) {
          console.log("twilio: clearing audio playback -> user is speaking");
          mediaStream.connection.sendUTF(JSON.stringify({ event: "clear", streamSid }));
          mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Clear" }));
          speaking = false;
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      // Au cas où on reçoit l'événement sans is_final
      if (is_finals.length > 0) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Utterance End => Speech Final] ${utterance}`);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, () => {
      console.log("deepgram STT: Disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
      console.error("deepgram STT: Error:", error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, (warning) => {
      console.warn("deepgram STT: Warning:", warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: Metadata:", data);
    });
  });

  return deepgram;
}

function setupDeepgramTTS(mediaStream) {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on("open", () => {
    console.log("deepgram TTS: Connected");
  });

  ws.on("message", (data) => {
    if (!speaking) return;
    try {
      const maybeJson = JSON.parse(data);
      console.log("deepgram TTS: (JSON message)", maybeJson);
      return;
    } catch (err) {
      // Ce n'est pas du JSON => c'est l'audio
    }

    if (firstByte) {
      const diff = Date.now() - ttsStart;
      console.log(`deepgram TTS: Time to First Byte = ${diff} ms`);
      firstByte = false;
      if (send_first_sentence_input_time) {
        console.log("deepgram TTS: TTFB from end of sentence token =",
          Date.now() - send_first_sentence_input_time, "ms");
      }
    }

    const payload = data.toString("base64");
    const message = {
      event: "media",
      streamSid: streamSid,
      media: { payload },
    };
    mediaStream.connection.sendUTF(JSON.stringify(message));
  });

  ws.on("close", () => {
    console.log("deepgram TTS: Disconnected");
  });

  ws.on("error", (err) => {
    console.error("deepgram TTS: error:", err);
  });

  return ws;
}

// ------------------------------
// 7) LLM (OpenAI) streaming
// ------------------------------
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      {
        role: "assistant",
        content: "You are funny, everything is a joke to you.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  speaking = true;
  let firstToken = true;

  for await (const chunk of stream) {
    if (!speaking) break;
    if (firstToken) {
      const duration = Date.now() - llmStart;
      ttsStart = Date.now();
      console.log(`openai LLM: Time to First Token = ${duration} ms`);
      firstToken = false;
      firstByte = true;
    }

    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      process.stdout.write(chunkMessage);
      if (!send_first_sentence_input_time && containsAnyChars(chunkMessage)) {
        send_first_sentence_input_time = Date.now();
      }
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({
        type: "Speak",
        text: chunkMessage,
      }));
    }
  }

  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
}

// ------------------------------
// 8) Lancement du serveur
// ------------------------------
HTTP_SERVER.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Endpoints disponibles:`);
  console.log(` - POST /ping (test)`);
  console.log(` - POST /twiml (TwiML inbound/outbound)`);
  console.log(` - POST /outbound (initier un appel sortant)`);
});
