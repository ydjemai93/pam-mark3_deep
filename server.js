// server.js

// 1) Modules de base
const fs = require("fs");
const http = require("http");
const path = require("path");

// 2) Chargement des variables d'environnement
require("dotenv").config();

// 3) WebSocket
const WebSocket = require("ws");

// 4) Twilio
const twilio = require("twilio");
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 5) HttpDispatcher pour router les requêtes
const HttpDispatcher = require("httpdispatcher");
const dispatcher = new HttpDispatcher();

// 6) WebSocketServer (pour Twilio Media Streams)
const { server: WebSocketServer } = require("websocket");

// 7) Deepgram (STT)
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// 8) OpenAI
const OpenAI = require("openai");
const openai = new OpenAI();

// 9) Configuration
const HTTP_SERVER_PORT = process.env.PORT || 8080;
let streamSid = ""; // Pour stocker l'ID de la session de streaming
let keepAlive;
let speaking = false;
let firstByte = true;
let llmStart = 0;
let ttsStart = 0;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// 10) Création du serveur HTTP
const wsserver = http.createServer(handleRequest);

// ---------------------------------------------------------------------
// GESTIONNAIRE DE REQUÊTES
// ---------------------------------------------------------------------
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

//
// Petit helper pour parser le body en JSON (puisque httpdispatcher ne le fait pas d'office)
//
function parseJSONBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        resolve(data);
      } catch (error) {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------
// ENDPOINT / (debug)
// ---------------------------------------------------------------------
dispatcher.onGet("/", function (req, res) {
  console.log("GET /");
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello, World! Twilio + Deepgram + GPT Agent is running.");
});

// ---------------------------------------------------------------------
// ENDPOINT /twiml
// Retourne le XML (streams.xml) avec la balise <Connect><Stream>...
// ---------------------------------------------------------------------
dispatcher.onPost("/twiml", function (req, res) {
  const filePath = path.join(__dirname, "templates", "streams.xml");
  try {
    let streamsXML = fs.readFileSync(filePath, "utf8");
    // Récupérer le domaine du serveur depuis process.env.SERVER
    let serverUrl = process.env.SERVER || "localhost";
    // Enlever http:// ou https:// s'ils sont présents
    serverUrl = serverUrl.replace(/^https?:\/\//, "");

    // Remplacer la chaîne <YOUR NGROK URL> par serverUrl
    streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);

    res.writeHead(200, {
      "Content-Type": "text/xml",
      "Content-Length": Buffer.byteLength(streamsXML),
    });
    res.end(streamsXML);
  } catch (err) {
    console.error("Erreur lors de la lecture du fichier streams.xml :", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

// ---------------------------------------------------------------------
// NOUVEL ENDPOINT /outbound
// Pour lancer un appel sortant depuis votre agent IA vers un numéro utilisateur
// ---------------------------------------------------------------------
dispatcher.onPost("/outbound", async function (req, res) {
  try {
    // On parse le body JSON
    const data = await parseJSONBody(req);
    if (!data || !data.to) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: 'Missing "to" in JSON body' }));
    }

    const toNumber = data.to;
    // Lancer l'appel via Twilio
    const call = await twilioClient.calls.create({
      from: process.env.TWILIO_FROM_NUMBER, // Numéro Twilio
      to: toNumber,                         // Numéro cible (depuis Webflow/Xano)
      // Quand la personne décroche, Twilio appelle /twiml pour streamer
      url: `https://${process.env.SERVER}/twiml`,
    });

    console.log("Twilio call initiated, SID =", call.sid);

    // Répondre à Xano / au client
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", callSid: call.sid }));
  } catch (err) {
    console.error("Error while placing call:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ---------------------------------------------------------------------
// Lancement du serveur HTTP
// ---------------------------------------------------------------------
wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on port:", HTTP_SERVER_PORT);
});

// ---------------------------------------------------------------------
// WEBSOCKET (pour Twilio /streams)
// ---------------------------------------------------------------------
const mediaws = new WebSocketServer({
  httpServer: wsserver,
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

// ---------------------------------------------------------------------
// Classe MediaStream : gère le flux media bidirectionnel
// ---------------------------------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;

    // Init STT & TTS
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramTTS(this);

    // Events Twilio
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
            console.log("twilio: First Media event received:", data);
            console.log("twilio: (Suppressing additional media logs...)");
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
          console.log("twilio: Close event received:", data);
          this.close();
          break;

        default:
          // ex: mark events, etc.
          break;
      }
    } else {
      console.log("twilio: binary message received (ignored).");
    }
  }

  close() {
    console.log("twilio: MediaStream closed.");
  }
}

// ---------------------------------------------------------------------
// FONCTION : LLM (OpenAI) => streaming
// ---------------------------------------------------------------------
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      {
        role: "assistant",
        content: `You are funny, everything is a joke to you.`,
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
    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      if (firstToken) {
        const duration = Date.now() - llmStart;
        ttsStart = Date.now();
        console.warn("\n>>> openai LLM: Time to First Token =", duration, "ms\n");
        firstToken = false;
        firstByte = true;
      }
      process.stdout.write(chunkMessage);

      // Détection ponctuation => on enverra le TTS par "paquets"
      if (!send_first_sentence_input_time && containsAnyChars(chunkMessage)) {
        send_first_sentence_input_time = Date.now();
      }
      // Envoi vers le websocket TTS
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Speak", text: chunkMessage }));
    }
  }

  // Flush final
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Flush" }));
}

function containsAnyChars(str) {
  let strArray = Array.from(str);
  return strArray.some((char) => chars_to_check.includes(char));
}

// ---------------------------------------------------------------------
// FONCTION : Setup du Websocket TTS => Deepgram
// ---------------------------------------------------------------------
function setupDeepgramTTS(mediaStream) {
  const url = process.env.DEEPGRAM_TTS_WS_URL || "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none";
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  };
  const ws = new WebSocket(url, options);

  ws.on("open", () => {
    console.log("deepgram TTS: Connected");
  });

  ws.on("message", (data) => {
    if (!speaking) return;
    try {
      let json = JSON.parse(data.toString());
      console.log("deepgram TTS:", json);
      // On peut ignorer la réponse JSON (metadata, etc.)
    } catch (e) {
      // Si ce n'est pas du JSON, on suppose que c'est de l'audio
      if (firstByte) {
        const duration = Date.now() - ttsStart;
        console.warn("\n>>> deepgram TTS: Time to First Byte =", duration, "ms\n");
        firstByte = false;
        if (send_first_sentence_input_time) {
          console.log(">>> deepgram TTS: TTFB from end of sentence token =", Date.now() - send_first_sentence_input_time, "ms");
        }
      }
      const payload = data.toString("base64");
      const message = {
        event: "media",
        streamSid: streamSid,
        media: { payload },
      };
      mediaStream.connection.sendUTF(JSON.stringify(message));
    }
  });

  ws.on("close", () => {
    console.log("deepgram TTS: Disconnected.");
  });

  ws.on("error", (error) => {
    console.error("deepgram TTS: Error:", error);
  });

  return ws;
}

// ---------------------------------------------------------------------
// FONCTION : Setup du streaming STT => Deepgram
// ---------------------------------------------------------------------
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
  }, 10000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
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

          // Si l'agent est en train de parler, on "coupe" le TTS pour laisser l'utilisateur parler
          if (speaking) {
            console.log("twilio: clearing audio playback");
            mediaStream.connection.sendUTF(JSON.stringify({ event: "clear", streamSid }));
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: "Clear" }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: Disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram STT: Error received:", error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: Warning received:", warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: Metadata received:", data);
    });
  });

  return deepgram;
}
