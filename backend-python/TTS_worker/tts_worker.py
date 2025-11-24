import pika
import json
import time
import os
import base64
from TTS.api import TTS
import torch # Coqui TTS often requires torch

# --- Configuration ---
RABBITMQ_URL = os.getenv('RABBITMQ_URL', 'amqp://localhost')
JOBS_EXCHANGE = 'aurasign_pipeline'
CONSUME_QUEUE = 'tts_tasks_queue'
CONSUME_ROUTING_KEY = 'tts_task'

# Dead Letter Exchange setup for fallback
DEAD_LETTER_EXCHANGE = 'aurasign_dlx'
DEAD_LETTER_QUEUE = 'aurasign_tts_dead_letter' # Ensure Node.js listens here
MESSAGE_TTL = 7000  # Increased TTL to 7 seconds for potentially slower TTS

# --- TTS Model Loading ---
try:
    # Check if GPU is available
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"✅ Using device: {device}")

    # --- Use a Pre-built Coqui TTS Model (e.g., VITS) ---
    # This model will be downloaded automatically on the first run if not cached.
    # It provides a standard female English voice.
    model_name = "tts_models/en/ljspeech/vits" # Example pre-built model
    tts = TTS(model_name, gpu=(device=="cuda"))
    print(f"✅ Coqui TTS model '{model_name}' loaded successfully.")

except Exception as e:
    print(f"🔴 Error loading TTS model: {e}")
    print("Please ensure Coqui TTS is installed (`pip install TTS`).")
    exit(1)

def generate_audio(sentence, emotion):
    """
    Generates WAV audio from text using the pre-built VITS model
    and returns it as a base64 string.
    Note: Standard models like VITS have limited emotion control.
    """
    try:
        temp_audio_path = f"temp_output_{time.time_ns()}.wav" # Unique temp file name

        # Generate audio using the pre-built model. No speaker_wav needed.
        tts.tts_to_file(
            text=sentence,
            # emotion=emotion, # Standard models might ignore or misuse this.
            language="en",
            file_path=temp_audio_path
        )

        # Read the file and encode it in base64
        with open(temp_audio_path, "rb") as wav_file:
            encoded_string = base64.b64encode(wav_file.read()).decode('utf-8')

        os.remove(temp_audio_path) # Clean up the temp file
        return encoded_string
    except Exception as e:
        print(f"🔴 Error generating TTS audio: {e}")
        # Clean up temp file even if error occurred
        if os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
        return None

def on_message_received(ch, method, properties, body):
    correlation_id = properties.correlation_id
    reply_to_queue = properties.reply_to
    print(f"\n[TTS Worker] Received job for correlation ID: {correlation_id}")

    try:
        job_data = json.loads(body)
        sentence = job_data.get('sentence')
        emotion = job_data.get('emotion') # Kept for potential future use
        tone = job_data.get('tone', 'Casual')

        if not sentence:
            print("🔴 Received job with no sentence.")
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            return

        # Generate audio using the pre-built model
        audio_base64 = generate_audio(sentence, emotion)

        if audio_base64:
            final_result = {
                'sentence': sentence,
                'audioData': audio_base64,
                'conversationTone': tone
            }

            # Publish to the 'reply_to' queue specified by the Node.js server
            ch.basic_publish(
                exchange='',
                routing_key=reply_to_queue,
                properties=pika.BasicProperties(correlation_id=correlation_id),
                body=json.dumps(final_result)
            )
            print(f"[TTS Worker] ✅ Published final audio result for job {correlation_id}")
            ch.basic_ack(delivery_tag=method.delivery_tag)
        else:
            print(f"🔴 Failed to generate audio for job {correlation_id}. Nacking message.")
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

    except Exception as e:
        print(f"🔴 Unexpected error processing TTS job {correlation_id}: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)


def main():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()

            # --- Setup Dead Letter Exchange & Queue ---
            channel.exchange_declare(exchange=DEAD_LETTER_EXCHANGE, exchange_type='fanout')
            channel.queue_declare(queue=DEAD_LETTER_QUEUE, durable=False)
            channel.queue_bind(exchange=DEAD_LETTER_EXCHANGE, queue=DEAD_LETTER_QUEUE)

            # --- Setup the main TTS queue with TTL and DLX ---
            channel.exchange_declare(exchange=JOBS_EXCHANGE, exchange_type='direct', durable=False)
            channel.queue_declare(
                queue=CONSUME_QUEUE,
                durable=False,
                arguments={
                    'x-message-ttl': MESSAGE_TTL,
                    'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE
                }
            )
            channel.queue_bind(exchange=JOBS_EXCHANGE, queue=CONSUME_QUEUE, routing_key=CONSUME_ROUTING_KEY)
            channel.basic_qos(prefetch_count=1)

            print('👂 TTS Worker listening for messages...')
            channel.basic_consume(queue=CONSUME_QUEUE, on_message_callback=on_message_received)
            channel.start_consuming()

        except pika.exceptions.AMQPConnectionError as e:
            print(f"🔴 Connection failed: {e}. Retrying in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            print("🛑 Shutting down.")
            break
        except Exception as e:
            print(f"🔴 An unexpected error occurred in main loop: {e}. Retrying...")
            time.sleep(5)


if __name__ == '__main__':
    main()

