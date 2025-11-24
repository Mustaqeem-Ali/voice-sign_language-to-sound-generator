const WebSocket = require('ws');
const amqp = require('amqplib');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const wss = new WebSocket.Server({ port: 8080 });
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const JOBS_EXCHANGE = 'aurasign_pipeline';
const NOTIFICATION_QUEUE = 'aggregator_notifications_to_nodejs'; // NEW queue for Node.js to listen to
const RESULTS_QUEUE = 'aurasign_results_to_nodejs';
const DEAD_LETTER_QUEUE = 'aurasign_tts_dead_letter';

const waitingClients = new Map();
let amqpChannel; // Keep channel in a higher scope

// --- Redis Client ---
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('🔴 Redis Client Error', err));

// --- Main RabbitMQ & Redis Connection ---
async function setupInfrastructure() {
    try {
        // Connect to Redis
        await redisClient.connect();
        console.log('📦 Redis connected successfully.');

        // Connect to RabbitMQ
        const connection = await amqp.connect(RABBITMQ_URL);
        amqpChannel = await connection.createChannel();
        console.log('🐇 RabbitMQ connected successfully.');

        // Declare exchanges and queues
        await amqpChannel.assertExchange(JOBS_EXCHANGE, 'direct', { durable: false });
        await amqpChannel.assertQueue(RESULTS_QUEUE, { durable: false });
        await amqpChannel.assertQueue(DEAD_LETTER_QUEUE, { durable: false });
        
        // NEW: Queue for notifications from recognition workers
        await amqpChannel.assertQueue(NOTIFICATION_QUEUE, { durable: false });
        // Bind it to the exchange with a specific routing key
        await amqpChannel.bindQueue(NOTIFICATION_QUEUE, JOBS_EXCHANGE, 'aggregator_task');

        console.log('👂 Listening for messages on RabbitMQ queues...');

        // Consumers
        amqpChannel.consume(RESULTS_QUEUE, handleResultMessage, { noAck: false });
        amqpChannel.consume(DEAD_LETTER_QUEUE, handleDeadLetterMessage, { noAck: false });
        amqpChannel.consume(NOTIFICATION_QUEUE, handleAggregationNotification, { noAck: false });

    } catch (error) {
        console.error('🔴 Infrastructure connection failed:', error);
        process.exit(1);
    }
}

// --- Message Handlers ---
function handleResultMessage(msg) {
    if (msg) {
        amqpChannel.ack(msg);
        const correlationId = msg.properties.correlationId;
        const client = waitingClients.get(correlationId);
        if (client && client.readyState === WebSocket.OPEN) {
            console.log(`[Main Server] ✅ Received final result for job ${correlationId}`);
            client.send(msg.content.toString());
            waitingClients.delete(correlationId);
        }
    }
}
function handleDeadLetterMessage(msg) {
    if (msg) {
        amqpChannel.ack(msg);
        const correlationId = msg.properties.correlationId;
        const client = waitingClients.get(correlationId);
        if (client && client.readyState === WebSocket.OPEN) {
            const failedJob = JSON.parse(msg.content.toString());
            console.warn(`[Main Server] ⚠️ TTS job failed for ${correlationId}. Sending text fallback.`);
            client.send(JSON.stringify({
                fallbackText: `Audio unavailable. Translation: "${failedJob.sentence}"`,
                conversationTone: 'Error'
            }));
            waitingClients.delete(correlationId);
        }
    }
}

// NEW: Aggregator Logic now lives in Node.js
async function handleAggregationNotification(msg) {
    if (msg) {
        const correlationId = msg.properties.correlationId;
        const redisKey = `job:${correlationId}`;
        console.log(`[Aggregator] Received notification for job: ${correlationId}`);

        try {
            const jobParts = await redisClient.hGetAll(redisKey);
            
            const rawGloss = jobParts.raw_gloss;
            const dominantEmotion = jobParts.dominant_emotion;

            if (rawGloss !== undefined && dominantEmotion !== undefined) {
                console.log(`[Aggregator] Both parts ready for ${correlationId}. Forwarding to Gemini.`);

                const next_job_payload = {
                    raw_gloss: rawGloss,
                    dominant_emotion: dominantEmotion,
                    user_tone: jobParts.user_tone || 'Casual'
                };

                amqpChannel.publish(
                    JOBS_EXCHANGE,
                    'gemini_task', // Routing key for the Gemini worker
                    Buffer.from(JSON.stringify(next_job_payload)),
                    { correlationId: correlationId, replyTo: msg.properties.replyTo }
                );

                await redisClient.del(redisKey);
                console.log(`[Aggregator] ✅ Published to Gemini and cleaned up Redis for ${correlationId}`);
            } else {
                console.log(`[Aggregator] Waiting for other part of job ${correlationId}...`);
            }
        } catch (err) {
            console.error(`[Aggregator] Redis error for job ${correlationId}:`, err);
        }
        amqpChannel.ack(msg);
    }
}

// --- WebSocket Server Logic ---
setupInfrastructure().then(() => {
    wss.on('connection', (ws) => {
        console.log('✅ Client connected');
        ws.landmarkSequences = [];

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                if (data.type === 'signing_data') {
                    ws.landmarkSequences.push(data.sequence);
                } else if (data.type === 'end_of_sentence') {
                    if (ws.landmarkSequences.length > 0) {
                        const correlationId = uuidv4();
                        const jobPayload = {
                            landmark_data: ws.landmarkSequences,
                            user_tone: data.tone || 'Casual'
                        };

                        waitingClients.set(correlationId, ws);
                        
                        // Store user_tone in Redis immediately for the aggregator
                        await redisClient.hSet(`job:${correlationId}`, 'user_tone', jobPayload.user_tone);
                        await redisClient.expire(`job:${correlationId}`, 300); // Set expiry

                        amqpChannel.publish(
                            JOBS_EXCHANGE,
                            'recognition_task', // Routing key for the first workers
                            Buffer.from(JSON.stringify(jobPayload)),
                            { correlationId: correlationId, replyTo: RESULTS_QUEUE }
                        );

                        console.log(`🚀 Published job ${correlationId} to the pipeline.`);
                    }
                    ws.landmarkSequences = [];
                }
            } catch (error) {
                console.error('Error processing message:', error);
                ws.send(JSON.stringify({ error: 'An internal error occurred.' }));
            }
        });

        ws.on('close', () => console.log('❌ Client disconnected.'));
        ws.on('error', (error) => console.error('WebSocket error:', error));
    });
});

