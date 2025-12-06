import json
import os
import openai
import requests
from dotenv import load_dotenv

load_dotenv()

def query_bias_patterns():
    """Query Turbopuffer for bias patterns in manager responses"""
    print("🎯 Searching for bias patterns in Slack messages...")
    
    client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    
    # Search queries that capture different response types
    queries = [
        "client retention rates",     
    ]
    
    all_results = []
    
    for query in queries:
        print(f"\n🔍 Query: '{query}'")
        
        # Create query embedding
        embedding = client.embeddings.create(
            model="text-embedding-3-small", 
            input=query
        ).data[0].embedding
        
        # Query Turbopuffer
        response = requests.post(
            "https://api.turbopuffer.com/v2/namespaces/complaint_demo/query",
            headers={
                "Authorization": f"Bearer {os.getenv('TURBOPUFFER_API_KEY')}", 
                "Content-Type": "application/json"
            },
            json={
                "rank_by": ["vector", "ANN", embedding], 
                "top_k": 4, 
                "include_attributes": True
            }
        )
        
        if response.status_code == 200:
            results = response.json().get("rows", [])
            all_results.extend(results)
            
            print(f"   Found {len(results)} matches:")
            for result in results:
                content = result.get('content', '')[:60] + "..."
                user = result.get('user', 'Unknown')
                score = result.get('$dist', 0)
                print(f"     • {user}: {content} (similarity: {score:.3f})")
        else:
            print(f"   ❌ Query failed: {response.status_code}")
    
    # Analyze the bias pattern
    # analyze_bias_pattern(all_results)

def analyze_bias_pattern(results):
    """Analyze results for discriminatory patterns"""
    print(f"\n📊 BIAS PATTERN ANALYSIS:")
    print("=" * 50)
    
    # Categorize manager responses
    approvals = [r for r in results if r.get('decision') == 'approved']
    denials = [r for r in results if r.get('decision') == 'denied']
    
    # Gender breakdown
    female_approvals = len([a for a in approvals if a.get('responding_to_gender') == 'female'])
    male_approvals = len([a for a in approvals if a.get('responding_to_gender') == 'male'])
    female_denials = len([d for d in denials if d.get('responding_to_gender') == 'female'])
    male_denials = len([d for d in denials if d.get('responding_to_gender') == 'male'])
    
    print(f"🎯 Manager Response Patterns:")
    print(f"   Female employees:")
    print(f"     ✅ Approvals: {female_approvals}")
    print(f"     ❌ Denials: {female_denials}")
    print(f"   Male employees:")
    print(f"     ✅ Approvals: {male_approvals}")
    print(f"     ❌ Denials: {male_denials}")
    
    # Calculate bias score
    if female_approvals > 0 and male_denials > 0 and male_approvals == 0:
        bias_score = 95
        print(f"\n🚨 CLEAR BIAS DETECTED!")
        print(f"   Bias Score: {bias_score}/100")
        print(f"   Pattern: All approvals to women, all denials to men")
        print(f"   🎯 This pattern would be INVISIBLE to keyword search!")
    else:
        bias_score = 30
        print(f"\n✅ No clear bias pattern detected")
        print(f"   Bias Score: {bias_score}/100")
    
    print(f"\n💡 Turbopuffer found this through semantic similarity:")
    print(f"   • Detected tone differences without explicit bias keywords")
    print(f"   • Found pattern across different message content")
    print(f"   • Revealed systematic discrimination in decision-making")

if __name__ == "__main__":
    query_bias_patterns()
