import pika
import json
import numpy as np
import joblib
import time
from collections import Counter
import redis

# --- RabbitMQ Configuration ---
RABBITMQ_URL = 'amqp://localhost'
JOBS_EXCHANGE = 'aurasign_pipeline'
CONSUME_QUEUE = 'recognition_tasks_queue'
CONSUME_ROUTING_KEY = 'recognition_task'
NEXT_ROUTING_KEY = 'aggregator_task' # UPDATED: Notify the Node.js aggregator

# --- Redis Configuration ---
redis_client = redis.Redis(host='localhost', port=6379, db=0)

# --- ML Model Loading ---
try:
    emotion_model = joblib.load('model.pkl')
    print("✅ Emotion model loaded successfully.")
except Exception as e:
    print(f"🔴 Error loading emotion model: {e}")
    exit()

# --- Preprocessing & Prediction Logic ---
def preprocess_landmarks(frame_landmarks):
    FACE_START_INDEX = 132 + 63 + 63 # 258
    FACE_LANDMARK_COUNT = 1404 # 468 * 3
    if len(frame_landmarks) < FACE_START_INDEX + FACE_LANDMARK_COUNT:
        return None
    face_landmarks = frame_landmarks[FACE_START_INDEX : FACE_START_INDEX + FACE_LANDMARK_COUNT]
    landmarks = np.array(face_landmarks, dtype=np.float32).reshape(468, 3)
    landmarks -= np.mean(landmarks, axis=0)
    max_val = np.max(np.abs(landmarks))
    if max_val < 1e-8:
        max_val = 1e-8
    landmarks /= max_val
    return landmarks.flatten()

def get_dominant_emotion(landmark_sequence):
    emotions = []
    for frame_landmarks in landmark_sequence:
        try:
            processed = preprocess_landmarks(frame_landmarks)
            if processed is None: continue
            if len(processed) != emotion_model.n_features_in_: continue
            prediction = emotion_model.predict([processed])
            emotions.append(prediction[0])
        except Exception as e:
            print(f"Error processing frame: {e}")
            continue
    if not emotions: return 'neutral'
    return Counter(emotions).most_common(1)[0][0]

def on_message_received(ch, method, properties, body):
    correlation_id = properties.correlation_id
    print(f"\n[Emotion Worker] Received job with correlation_id: {correlation_id}")

    try:
        job_data = json.loads(body)
        landmark_data = job_data.get('landmark_data', [])
        dominant_emotion = get_dominant_emotion(landmark_data)
        print(f"[Emotion Worker] Predicted Dominant Emotion: '{dominant_emotion}'")

        # --- Step 1: Save result to Redis ---
        redis_key = f"job:{correlation_id}"
        redis_client.hset(redis_key, "dominant_emotion", dominant_emotion)

        # --- Step 2: Notify the Aggregator (Node.js server) ---
        notification_payload = { 'part_received': 'emotion' }
        ch.basic_publish(
            exchange=JOBS_EXCHANGE,
            routing_key=NEXT_ROUTING_KEY,
            properties=pika.BasicProperties(
                correlation_id=correlation_id,
                reply_to=properties.reply_to
            ),
            body=json.dumps(notification_payload)
        )
        print(f"[Emotion Worker] ✅ Notified Node.js Aggregator for job {correlation_id}")

    except Exception as e:
        print(f"🔴 Error handling message in Emotion Worker: {e}")

    ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            channel.exchange_declare(exchange=JOBS_EXCHANGE, exchange_type='direct')
            channel.queue_declare(queue=CONSUME_QUEUE)
            channel.queue_bind(exchange=JOBS_EXCHANGE, queue=CONSUME_QUEUE, routing_key=CONSUME_ROUTING_KEY)
            print('👂 Emotion Worker listening for messages...')
            channel.basic_consume(queue=CONSUME_QUEUE, on_message_callback=on_message_received)
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError as e:
            print(f"🔴 Connection failed: {e}. Retrying in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            print("🛑 Shutting down.")
            break

if __name__ == '__main__':
    main()

