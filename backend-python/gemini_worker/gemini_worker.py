import pika
import json
import time
import os
import google.generativeai as genai

# --- Configuration ---
RABBITMQ_URL = 'amqp://localhost'
JOBS_EXCHANGE = 'aurasign_pipeline'
CONSUME_QUEUE = 'gemini_tasks_queue'
CONSUME_ROUTING_KEY = 'gemini_task'
NEXT_ROUTING_KEY = 'tts_task'
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY') # IMPORTANT: Set this environment variable

if not GEMINI_API_KEY:
    print("🔴 Error: GEMINI_API_KEY environment variable not set.")
    exit()

genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel('gemini-2.5-flash')

def get_gemini_response(raw_gloss, dominant_emotion):
    prompt = f"""
        You are an expert in linguistics and communication. Your task is to interpret sign language gloss and emotion.
        Given the following raw sign language gloss and the user's dominant emotion, perform two tasks:
        1. Convert the gloss into a natural, grammatically correct, conversational English sentence.
        2. Analyze the combination of the sentence and emotion to determine the overall conversational tone. The tone should be one of: Formal, Casual, Sarcastic, Excited, Sad, or Questioning.
        Return the response as a single, minified JSON object with two keys: "sentence" and "tone". Do not include any other text or markdown formatting.
        ---
        Input:
        Emotion: {dominant_emotion}
        Gloss: {raw_gloss}
    """
    try:
        response = gemini_model.generate_content(prompt)
        result_json = json.loads(response.text)
        return result_json['sentence'], result_json['tone']
    except Exception as e:
        print(f"🔴 Error calling Gemini API: {e}")
        return "Sorry, I was unable to process that.", "Error"

def on_message_received(ch, method, properties, body):
    print(f"\nReceived job from Emotion Worker with correlation ID: {properties.correlationId}")
    job_data = json.loads(body)
    
    sentence, tone = get_gemini_response(job_data['raw_gloss'], job_data['dominant_emotion'])
    print(f"Gemini Result -> Sentence: '{sentence}', Tone: '{tone}'")
    
    next_job_payload = {
        'sentence': sentence,
        'emotion': job_data['dominant_emotion'] # Pass the original emotion for TTS styling
    }

    ch.basic_publish(
        exchange=JOBS_EXCHANGE,
        routing_key=NEXT_ROUTING_KEY,
        properties=pika.BasicProperties(
            correlation_id=properties.correlationId,
            reply_to=properties.reply_to
        ),
        body=json.dumps(next_job_payload)
    )
    
    print(f"✅ Published result to '{NEXT_ROUTING_KEY}'")
    ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
            channel = connection.channel()
            channel.exchange_declare(exchange=JOBS_EXCHANGE, exchange_type='direct')
            channel.queue_declare(queue=CONSUME_QUEUE)
            channel.queue_bind(exchange=JOBS_EXCHANGE, queue=CONSUME_QUEUE, routing_key=CONSUME_ROUTING_KEY)

            print('👂 Gemini Worker listening for messages...')
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
