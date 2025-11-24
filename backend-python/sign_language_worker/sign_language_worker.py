import pika
import json
import numpy as np
import tensorflow as tf
import time
from collections import deque
import redis

# --- RabbitMQ Configuration ---
RABBITMQ_URL = 'amqp://localhost'
JOBS_EXCHANGE = 'aurasign_pipeline'
RECOGNITION_QUEUE = 'recognition_tasks_queue'
RECOGNITION_ROUTING_KEY = 'recognition_task'
NEXT_ROUTING_KEY = 'aggregator_task' # UPDATED: Notify the Node.js aggregator

# --- Redis Configuration ---
redis_client = redis.Redis(host='localhost', port=6379, db=0)

# --- ML Model Loading ---
try:
    model = tf.keras.models.load_model('action.h5')
    actions = np.load('actions.npy', allow_pickle=True)
    print("✅ Sign language model loaded successfully.")
except Exception as e:
    print(f"🔴 Error loading sign language model: {e}")
    exit(1)

CONFIDENCE_THRESHOLD = 0.9
SMOOTHING_WINDOW = 3
last_predictions = deque(maxlen=SMOOTHING_WINDOW)

def process_sequence(sequence):
    global last_predictions
    inp = np.expand_dims(np.array(sequence, dtype=np.float32), axis=0)
    res = model.predict(inp, verbose=0)[0]
    top_idx = int(np.argmax(res))
    confidence = float(res[top_idx])
    predicted_action = str(actions[top_idx])
    if confidence >= CONFIDENCE_THRESHOLD:
        if len(last_predictions) == 0 or predicted_action not in last_predictions:
            last_predictions.append(predicted_action)
            return predicted_action
    else:
        last_predictions.clear()
    return None

def on_message_received(ch, method, properties, body):
    correlation_id = properties.correlation_id
    print(f"\n[Sign Worker] Received job with correlation_id: {correlation_id}")
    
    job_data = json.loads(body)
    landmark_data = job_data.get('landmark_data', [])
    sentence_gloss = []
    global last_predictions
    last_predictions.clear()

    if landmark_data:
        for sequence in landmark_data:
            action = process_sequence(sequence)
            if action and (len(sentence_gloss) == 0 or action != sentence_gloss[-1]):
                sentence_gloss.append(action)

    raw_gloss = " ".join(sentence_gloss)
    print(f"[Sign Worker] Predicted Gloss: '{raw_gloss}'")

    # --- Step 1: Save result to Redis ---
    redis_key = f"job:{correlation_id}"
    redis_client.hset(redis_key, "raw_gloss", raw_gloss)
    
    # --- Step 2: Notify the Aggregator (Node.js server) ---
    notification_payload = { 'part_received': 'sign' }
    ch.basic_publish(
        exchange=JOBS_EXCHANGE,
        routing_key=NEXT_ROUTING_KEY,
        properties=pika.BasicProperties(
            correlation_id=correlation_id,
            reply_to=properties.reply_to # Pass this along
        ),
        body=json.dumps(notification_payload)
    )
    print(f"[Sign Worker] ✅ Notified Node.js Aggregator for job {correlation_id}")
    ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            channel.exchange_declare(exchange=JOBS_EXCHANGE, exchange_type='direct', durable=False)
            channel.queue_declare(queue=RECOGNITION_QUEUE, durable=False)
            channel.queue_bind(exchange=JOBS_EXCHANGE, queue=RECOGNITION_QUEUE, routing_key=RECOGNITION_ROUTING_KEY)
            channel.basic_qos(prefetch_count=1)
            print('👂 Sign Worker listening for messages...')
            channel.basic_consume(queue=RECOGNITION_QUEUE, on_message_callback=on_message_received)
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError as e:
            print(f"🔴 Connection failed: {e}. Retrying in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            print("🛑 Shutting down.")
            break

if __name__ == '__main__':
    main()

