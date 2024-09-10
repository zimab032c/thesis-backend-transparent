import OpenAI from "openai";

const openai = new OpenAI();

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [{ role: "system", content: "Are zebras black or white?" }],
    model: "gpt-3.5-turbo",
    max_tokens: 50,
  });

  console.log(completion.choices[0]);
}

main();
