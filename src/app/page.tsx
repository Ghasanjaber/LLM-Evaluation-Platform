"use client";

import { useState } from "react";

export default function Home() {
  const [inputText, setInputText] = useState(""); 
  const [selectedModels, setSelectedModels] = useState<string[]>([
    "gemini-1.5-pro",
    "gpt-4",
    "gpt-3.5-turbo",
  ]); 
  const [isLoading, setIsLoading] = useState(false); 
  const [responses, setResponses] = useState<
    Array<{ model: string; response: string; latency: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setResponses([]); 

    try {
      const response = await fetch("http://127.0.0.1:5000/api/evaluate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: inputText,
          models: selectedModels,
          temperature: 0.7,
          max_tokens: 100,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get LLM responses. Please try again.");
      }

      const data = await response.json();
      console.log("API Response:", data);

      if (Array.isArray(data)) {
        setResponses(
          data.map((res: any) => ({
            model: res.model_name,
            response: res.response_text,
            latency: res.latency_ms, 
          }))
        );
      } else {
        throw new Error("Unexpected API response format.");
      }

      setInputText(""); 
    } catch (error: any) {
      console.error("Error:", error);
      setError(error.message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

 
  const toggleModel = (model: string) => {
    setSelectedModels((prev) =>
      prev.includes(model)
        ? prev.filter((m) => m !== model)
        : [...prev, model]
    );
  };

  return (
    <div className="min-h-screen flex flex-col justify-between p-8 bg-black text-white">
      {}
      <header className="text-center mb-4">
        <h1 className="text-2xl font-bold text-yellow-400">
          LLM Evaluation Platform
        </h1>
        <p className="text-gray-300">
          Enter a prompt and compare responses from multiple LLMs
        </p>
      </header>

      {}
      <div className="flex gap-4 mb-4 justify-center">
        {["gemini-1.5-pro", "gpt-4", "gpt-3.5-turbo"].map((model) => (
          <label key={model} className="flex items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              value={model}
              checked={selectedModels.includes(model)}
              onChange={() => toggleModel(model)}
            />
            {model}
          </label>
        ))}
      </div>

      {}
      <main className="flex-1 flex flex-col items-center gap-4">
        <form onSubmit={handleSubmit} className="w-full max-w-3xl">
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              className="flex-1 p-3 rounded-lg bg-gray-700 border border-gray-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 text-white"
              placeholder="Enter your prompt for the LLM..."
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading}
              className="px-6 py-3 rounded-lg bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50"
            >
              {isLoading ? "Generating..." : "Submit"}
            </button>
          </div>
        </form>

        {}
        {error && <p className="text-red-500 mt-2">{error}</p>}

        {}
        <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
          {responses.map((res, index) => (
            <div
              key={index}
              className="p-4 border rounded-lg shadow bg-gray-800"
            >
              <h3 className="font-bold mb-2 text-center text-yellow-400">
                {res.model}
              </h3>
              <p className="text-sm mb-1 text-gray-300">
                <strong>Response:</strong> {res.response}
              </p>
              <p className="text-sm text-gray-400 text-center">
                ⏱️ <strong>Latency:</strong>{" "}
                {res.latency?.toFixed(2) || "N/A"} ms
              </p>
            </div>
          ))}
        </div>

        {}
        {responses.length > 0 && (
          <div className="w-full max-w-4xl mt-6 p-4 border-t border-gray-600">
            <h3 className="text-lg font-bold mb-2 text-yellow-400">
              Latency Summary:
            </h3>
            <ul>
              {responses.map((res, index) => (
                <li key={index} className="text-sm text-gray-300">
                  🔹 <strong>{res.model}:</strong>{" "}
                  {res.latency?.toFixed(2) || "N/A"} ms
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      {}
      <footer className="text-center text-gray-400 mt-8">
        <p>&copy; {new Date().getFullYear()} LLM Evaluation Platform</p>
      </footer>
    </div>
  );
}
