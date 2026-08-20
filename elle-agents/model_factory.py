"""
Fabrique de modèle partagée par tous les agents Elle.

Bascule entre un modèle local (Ollama) et un modèle cloud (Anthropic
Claude, Google Gemini, Groq, DeepSeek, OpenRouter) via la variable
d'environnement ELLE_MODEL_PROVIDER. Les agents appellent get_model() :
changer une seule variable d'env change le modèle utilisé PARTOUT, sans
toucher au code des agents.
"""
import os

from google.adk.models.lite_llm import LiteLlm

VALID_PROVIDERS = ("ollama", "anthropic", "gemini", "groq", "deepseek", "openrouter")


def get_model():
    provider = os.environ.get("ELLE_MODEL_PROVIDER", "ollama").strip().lower()

    if provider == "ollama":
        # OLLAMA_API_BASE doit être défini dans l'environnement
        # (http://localhost:11434, ou l'IP d'une autre machine du réseau
        # local si Ollama ne tourne pas sur le même appareil qu'Elle).
        model_name = os.environ.get("ELLE_OLLAMA_MODEL", "qwen2.5:7b-instruct")
        # Préfixe "ollama_chat/" obligatoire (pas "ollama/") : c'est ce qui
        # évite les boucles infinies d'appels d'outils avec ADK.
        return LiteLlm(model=f"ollama_chat/{model_name}")

    if provider == "anthropic":
        # Nécessite ANTHROPIC_API_KEY dans l'environnement.
        model_name = os.environ.get("ELLE_ANTHROPIC_MODEL", "claude-sonnet-4-6")
        return LiteLlm(model=f"anthropic/{model_name}")

    if provider == "groq":
        # Nécessite GROQ_API_KEY dans l'environnement. Inférence très rapide,
        # bon complément à Ollama quand la machine locale est trop lente.
        # Vérifiez le nom exact du modèle dans console.groq.com (le
        # catalogue change) et confirmez qu'il supporte le tool calling.
        model_name = os.environ.get("ELLE_GROQ_MODEL", "compound")
        return LiteLlm(model=f"groq/{model_name}")

    if provider == "gemini":
        # Nécessite GOOGLE_API_KEY dans l'environnement. Modèle Gemini
        # natif : pas besoin du wrapper LiteLlm ici, ADK sait déjà parler
        # directement à l'API Gemini avec une simple chaîne.
        return os.environ.get("ELLE_GEMINI_MODEL", "gemini-2.5-flash")

    if provider == "deepseek":
        # Nécessite DEEPSEEK_API_KEY dans l'environnement.
        # IMPORTANT : "deepseek-chat" et "deepseek-reasoner" sont retirés
        # par DeepSeek le 24 juillet 2026 (15:59 UTC) au profit des noms
        # canoniques ci-dessous — n'utilisez pas les anciens alias pour du
        # nouveau code, ils cesseront de fonctionner à cette date.
        model_name = os.environ.get("ELLE_DEEPSEEK_MODEL", "deepseek-v4-flash")
        return LiteLlm(model=f"deepseek/{model_name}")

    if provider == "openrouter":
        # Nécessite OPENROUTER_API_KEY dans l'environnement.
        # Deux modèles gratuits en fallback : Nemotron-3-ultra (principal)
        # puis GLM-5.2 (secours). LiteLLM gère le fallback automatique
        # si le premier modèle échoue (rate limit, erreur, etc.).
        primary_model = os.environ.get(
            "ELLE_OPENROUTER_PRIMARY_MODEL", "nvidia/nemotron-3-ultra-550b:free"
        )
        fallback_model = os.environ.get(
            "ELLE_OPENROUTER_FALLBACK_MODEL", "z-ai/glm-5.2:free"
        )
        # Format OpenRouter : "openrouter/<model>" — le fallback est passé
        # via le paramètre `fallbacks` de LiteLLM (liste de modèles).
        return LiteLlm(
            model=f"openrouter/{primary_model}",
            fallbacks=[f"openrouter/{fallback_model}"],
        )

    raise ValueError(
        f"ELLE_MODEL_PROVIDER inconnu : '{provider}'. "
        f"Valeurs possibles : {', '.join(VALID_PROVIDERS)}."
    )
