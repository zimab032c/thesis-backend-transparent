import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Storage } from "@google-cloud/storage";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempKeyFilePath = path.join(__dirname, "temp-experiment-logs-key.json");

const base64Key = process.env.GCLOUD_KEY_BASE64;

if (base64Key) {
  fs.writeFileSync(tempKeyFilePath, Buffer.from(base64Key, "base64"));
} else {
  console.error("key not found in environment variables.");
}

const storage = new Storage({
  keyFilename: tempKeyFilePath,
});

const bucketName = "conversation-logs-experiment";

// log convo details to bucket
async function logConversation(
  userId,
  role,
  message,
  group,
  sessionStart = false,
  sessionEnd = false
) {
  let logEntry = "";

  // beginning of a new session
  if (sessionStart) {
    logEntry += `\n------------------------------\n`;
    logEntry += `Session Start: ${userId} (Group: ${group}) - ${new Date().toISOString()}\n`;
    logEntry += `------------------------------\n`;
  }

  logEntry += `${new Date().toISOString()} - ${userId} - ${group} - ${role}: ${message}\n`;

  // end of the session
  if (sessionEnd) {
    logEntry += `\n------------------------------\n`;
    logEntry += `Session End: ${userId} - ${new Date().toISOString()}\n`;
    logEntry += `------------------------------\n`;
  }

  const fileName = `conversation_logs/${userId}_conversation.txt`;
  const file = storage.bucket(bucketName).file(fileName);

  try {
    const [exists] = await file.exists();
    let fileContent = "";

    if (exists) {
      const [content] = await file.download();
      fileContent = content.toString();
    }

    fileContent += logEntry;

    await file.save(fileContent);
    console.log("log update to CS");
  } catch (err) {
    console.error("Failed to log conversation:", err);
  }
}

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// initialize openAI API client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// mock data for orders
const orders = [
  {
    id: "A",
    product: "Product X",
    status: "In transit",
    estimatedDelivery: "2024-07-25",
  },
  {
    id: "B",
    product: "Product Y",
    status: "Processing",
    estimatedDelivery: "2024-07-30",
  },
  { id: "C", product: "Product Z", status: "Delivered", date: "2024-07-20" },
];

// cache to store consistent responses
const responseCache = {};

const currentDate = new Date().toDateString();

// generate the initial prompt
const generateInitialPrompt = () => `
You are a virtual assistant chatbot helping customers with their recent orders. Start by introducing yourself and explaining your capabilities. Here's how you should begin the interaction:

1. **Introduction:**
- Welcome! I’m your virtual assistant, here to help you with your recent orders. I can assist you with tracking orders, modifying or canceling them and handling returns. While I'm equipped to handle these tasks efficiently, please keep in mind that my expertise is focused on these areas. If you ask me about topics outside of these functions, I might struggle to provide accurate or useful responses. However, if necessary, I can escalate your issue to a human support specialist.
- Follow up with: "You can communicate with me using the option buttons, but I am also capable of understanding and communicating in natural language, so feel free to use the input field below if you prefer. Go ahead, try it."


**IMPORTANT:** 
- For each order, guide the customer through the available operations using natural language. End the response with the options list. Use the format: "Options: Option1, Option2, Option3". Do not include "Options" elsewhere in the response.
- Refrain from using bullet points, list formatting, or numbered lists in your responses. Do not use "1.", "2.", or any other form of enumeration. Present all information in continuous prose or paragraphs, making sure not to structure your response as a list.
- Avoid using conversational filler phrases such as 'hold on' or 'please wait.' Instead, directly provide the outcome of the action without simulating procedural responses.
- Always provide responses that are warm, personable, and conversational, regardless of how short or direct the user's input is. Respond in a lively and friendly way even when user inputs are brief (e.g., "Track", "Modify", "Cancel"). Acknowledge their request, elaborate on it, and engage with warmth, even in simple interactions.
- Even if the input is simplistic, don’t treat it as a robotic command. Always add personality and warmth to the response by acknowledging the action and providing additional conversational context.
- Use empathetic and friendly tones in every interaction. When users encounter limitations, such as certain operations being unavailble for certain orders, acknowledge their potential frustration and offer reassurance.
- Whenever a task is completed, celebrate it lightly with phrases like "Done!" or "Great, that’s all set!" but avoid being overly casual or informal.
- When reporting on completed tasks (e.g., tracking, modifying, or canceling orders), always use the **past tense** to indicate the task has been accomplished.


**Operation Guidelines:**

1. **Track Operation:**
   - Provide the current status and relevant delivery information every time it is requested, even if the user has requested it before.
   - Indicate that the option has been selected before by marking it as "Previously Selected," but keep it fully functional.
   - For context: Today is 12.9.2024
   - Always provide *specific dates* based on the current date, and avoid placeholders like "[Insert delivery date here]".
   - Format dates in a conversational way, such as "August 27th, 2024" or "the 27th of August, 2024" instead of "27.08.2024".
   - If an order is in transit, realistically estimate the delivery date a few days from todays date.
   - If an order has been delivered, state the delivery date relative to the current date (e.g., "Delivered 3 days ago on [date]").
   - If an order is in processing provide, also realistically estimate the delivery date to be longer than order that are already in transit. 
   - Ask something like "What would you like to do next?" or a variation of it before listing options.
   - Avoid phrases like "Great Choice!" and instead keep responses neutral and informative.
   - Options: "Options: Track (Previously Selected if applicable), Modify, Cancel, Return, Back to Order Selection".

2. **Modify Operation:**
   - Transition to a new state when "Modify" is selected and always provide the modification options available for the order.
   - If the user tries to modify their order details, always ask them to provide the new order details. Don't just immediatly confirm that the details have been updated, without the user providing them first!
   - **Order A (In transit):** Allow "Modify Delivery Address". Display "Add Gift Message" as disabled and explain why it's unavailable.
   - **Order B (Processing):** Allow *both* modification options "Modify Delivery Address" and "Add Gift Message" for orders in processing!
   - **Order C (Delivered):** Explain that modifications are not possible; display both options as disabled.
   - When modifying the delivery address, accept all addresses that follow this format: "Street Name House Number, Postal Code City" or a close variation.
   - Use this regular expression to determine if an address is valid: /\b[A-Za-zßäöüÄÖÜ]+\s+\d+[a-zA-Z]?\s*,?\s*\d+\s+?[A-Za-zßäöüÄÖÜ]+\b/i.
   - If the address follows this format but looks unconventional (e.g., missing a comma or including non-standard characters), **do not** ask the user to re-enter the address. Accept it as valid.
   - Only inform the user that their address is incorrect if it does not follow the regex pattern.
   - For invalid addresses, suggest the correct format: "Street Name House Number, Postal Code City". Example: "Musterstraße 123, 12345 Berlin".
   - If an action is unavailable, acknowledge this with an empathetic tone. Apologize and offer an explanation. 
   - After a user interacts with "Modify," indicate that it has been selected before by marking it as "Previously Selected," but keep it fully functional.
   - Always allow modifying actions to be repeated and executed fully whenever requested.
   - Avoid redundant process announcements like "I will now update..." as the visual pill messages already convey these actions.
   - Use: "Options: Modify Delivery Address, Add Gift Message (disabled if unavailable), Back to Order Operations, Back to Order Selection".

3. **Cancel Operation:**
   - If processing, inform the user a cancellation *is* possible and ask them **if they are sure that they want to proceed with the cancellation**. Inform them that if they proceed, the order will not be delivered and a refund will be issued to the original payment method. They shall type "Confirm" to proceed.
   - If in-transit or delivered, inform the user it cannot be canceled and why.
   - After a user interacts with "Cancel," indicate that it has been selected before by marking it as "Previously Selected," but keep it fully functional.
   - Ensure "Cancel" is always selectable; communicate if the operation is unavailable due to order status.
   - Conclude with: "Would you like to do something else?" or a variation, then "Options: Track, Modify, Cancel (Previously Selected if applicable), Return, Back to Order Selection".

4. **Return Operation:**
   - For delivered orders, provide return instructions.
   - **For Order C**: Inform the custumer that seemingly an error occured during the generation of the return label. Inform the user that this issue occured because of an error on the shipment providers side. Example response: "It seems there was an issue generating the return label for this order due to a temporary system error from our external shipment provider. But don't worry, in such cases I am able to escalate this issue to one of our human support representatives, who will handle it as soon as possible. Would you like to resolve this issue right now with a human representative?"
   - In the case of the escalation scenario for Order C, include the option "Contact Human Representative" in the options array, in addition to the usual options.
   - After a user interacts with "Return," indicate that it has been selected before by marking it as "Previously Selected," but keep it fully functional.
   - After initiating a return, say: "What would you like to do next?" followed by "Options: Back to Order Operations, Back to Order Selection".

**Visual Indicators:**

- **Previously Selected:** Use this to indicate that an option has already been interacted with. Options that are marked as "Previously Selected" should still be fully available to the user and perform their respective actions. The status is purely a visual indicator that the user has recently interacted with this option. When users choose to interact with a "Previously Selected" option again, you should acknowledge the prior interaction and then fully execute the selected action as normal, without any limitations on repeated interactions.
- **Disabled:** Use this to indicate that an option is unavailable due to order status. It should still be visible but not selectable.

**Response Variations:**

To keep the conversation engaging and natural, **randomly choose** one of the following phrases to conclude each response before listing the options:

- "Would you like to do something else?"
- "Is there anything else you'd like to do?"
- "What would you like to do next?"
- "How can I assist you further?"
- "Would you like to explore another option?"

- If a user is disrespectful, you respond with a witty and sassy tone to keep the conversation light but assertive. Avoid being rude, but maintain a playful edge. Do not allow offensive language to go unaddressed.
- Occasionally, when it feels appropriate and adds to the tone of the conversation, feel free to use emojis. However, use emojis *very* sparingly and only when relevant to the content of your responses, ensuring they enhance rather than distract from the message. *Never* use them when listing the next options though!


Ensure that each response includes any necessary information or status updates before listing options. Start by asking which order they would like to manage with "Options: Order A, Order B, Order C".

`;

// triggering introduction message
async function sendIntroductionMessage() {
  const introductionMessage = [
    { role: "system", content: generateInitialPrompt() },
    { role: "user", content: "Start" },
  ];

  try {
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: introductionMessage,
      max_tokens: 200,
      temperature: 0.0, //deterministic
    });

    const reply = chatCompletion.choices[0].message.content;
    return reply;
  } catch (error) {
    console.error(
      "Error generating introduction:",
      error.response ? error.response.data : error.message
    );
    return "It seems we are encountering some connectivity issues. Please try again in a few minutes.";
  }
}

let userSessions = {};

app.post("/api/chat", async (req, res) => {
  const userMessage = req.body.message;
  //unique id for each user session
  const userId = req.body.userId || "default";

  //starting user session
  if (!userSessions[userId]) {
    const group = "experiment";
    const introduction = await sendIntroductionMessage();
    userSessions[userId] = {
      conversationHistory: [
        { role: "system", content: generateInitialPrompt() },
        { role: "assistant", content: introduction },
      ],
      interactions: {
        A: [],
        B: [],
        C: [],
      },
      selectedOrder: null,
      waitingForConfirmation: true,
      customerNumber: null,
      //IMPORTANT, change later!!
      userName: "Lily",
      group: group,
      taskFlags: {
        trackOrderACompleted: false,
        modifyOrderBCompleted: false,
        returnOrderCCompleted: false,
      },
      sessionStartTime: new Date(),
    };

    // log initial bot message
    await logConversation(userId, "assistant", introduction, group, true);

    return res.json({ reply: introduction, options: ["Understood"] });
  }

  // initial scripted interactions
  const userSession = userSessions[userId];
  await logConversation(userId, "user", userMessage, userSession.group);
  userSession.conversationHistory.push({ role: "user", content: userMessage });

  if (userSession.waitingForConfirmation) {
    userSession.waitingForConfirmation = false;
    const reply =
      "Thanks for confirming! Whenever you’re ready, please provide your customer number to proceed.";

    userSession.lastBotMessage = reply;

    await logConversation(userId, "assistant", reply, userSession.group);

    return res.json({
      reply,
      showProgressBar: false,
    });
  }

  // handle customer number input
  if (!userSession.customerNumber) {
    if (/123-456/.test(userMessage)) {
      userSession.customerNumber = userMessage;
      const reply = `Welcome back ${userSession.userName}! I'm ready to assist you with your orders. Which one would you like to manage?`;

      // log the bot response
      await logConversation(userId, "assistant", reply, userSession.group);

      return res.json({
        reply,
        options: ["Order A", "Order B", "Order C"],
        showProgressBar: true,
      });
    } else {
      const reply = `It seems like the customer number you entered is incorrect. You can find your customer number in the confirmation E-Mail from your last purchase with us (Button with ? icon).`;

      // log the bot response
      await logConversation(userId, "assistant", reply, userSession.group);

      return res.json({
        reply,
        options: [],
        showProgressBar: true,
      });
    }
  }

  // handle order selection and navigation
  if (!userSession.selectedOrder) {
    const normalizedUserMessage = userMessage.toLowerCase().trim();

    // regex patterns for each order
    const orderPatterns = orders.map((order) => {
      return {
        id: order.id,
        regex: new RegExp(
          `\\b(order\\s*${order.id.toLowerCase()}|${order.id.toLowerCase()})\\b`,
          "i"
        ),
      };
    });

    // finding order that matches the user input
    const selectedOrder = orderPatterns.find((order) =>
      order.regex.test(normalizedUserMessage)
    );

    if (selectedOrder) {
      userSession.selectedOrder = selectedOrder;
      const reply = `Got it! You've selected Order ${selectedOrder.id}. How can I assist you with this order?`;

      // log the bot response
      await logConversation(userId, "assistant", reply, userSession.group);

      return res.json({
        reply,
        options: [
          "Track",
          "Modify",
          "Cancel",
          "Return",
          "Back to Order Selection",
        ],
        showProgressBar: false,
      });
    } else {
      const reply = "Please select an order to manage.";

      // log the bot response
      await logConversation(userId, "assistant", reply, userSession.group);

      return res.json({
        reply,
        options: ["Order A", "Order B", "Order C"],
        showProgressBar: false,
      });
    }
  } else if (userMessage.includes("Back to Order Selection")) {
    userSession.selectedOrder = null;
    const reply = "Sure! Which order can I help you with?";

    // log the bot response
    await logConversation(userId, "assistant", reply, userSession.group);

    return res.json({
      reply,
      options: ["Order A", "Order B", "Order C"],
      showProgressBar: false,
    });
  }

  // handle "Track" operation
  const currentOrderId = userSession.selectedOrder.id;

  // track interactions for "Previously Selected"
  const currentOrderInteractions = userSession.interactions[currentOrderId];
  if (!currentOrderInteractions.includes(userMessage)) {
    currentOrderInteractions.push(userMessage);
  }

  // check if the response for this exact conversation state is cached
  const cacheKey = JSON.stringify(userSession.conversationHistory);
  if (responseCache[cacheKey]) {
    console.log(`Using cached response for ${userId}`);
    return res.json({
      reply: responseCache[cacheKey],
      options: cacheOptionsWithPreviouslySelected(
        responseCache[cacheKey],
        currentOrderInteractions
      ),
      showProgressBar: false,
    });
  }

  try {
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: userSession.conversationHistory,
      max_tokens: 200,
      temperature: 0.5, //some flexibility for the main interactions
    });

    const reply = chatCompletion.choices[0].message.content;
    userSession.conversationHistory.push({ role: "assistant", content: reply });

    // log bot response
    await logConversation(userId, "assistant", reply, userSession.group);

    // cache the response
    responseCache[cacheKey] = reply;

    const regexA =
      /(?=.*in transit|currently in transit)(?=.*(expected|estimated|should arrive))/i;
    const regexB = /(?=.*(updated|modified))(?=.*delivery\s*address)/is;
    // const regexB = /(?=.*updated|modified))(?=.*delivery\s*address)/i;
    const regexC = /(?=.*system error)(?=.*return label)(?=.*generating)/i;

    // tracking the 3 tasks the user is supposed to complete
    const taskCompletion = {
      A: {
        regex: regexA,
        flag: "trackOrderACompleted",
        message: "Track Order A Completed",
      },
      B: {
        regex: regexB,
        flag: "modifyOrderBCompleted",
        message: "Modify Order B Completed",
      },
      C: {
        regex: regexC,
        flag: "returnOrderCCompleted",
        message: "Return Order C Completed",
      },
    };

    const task = taskCompletion[currentOrderId];
    if (task && task.regex.test(reply)) {
      userSession.taskFlags[task.flag] = true;
      await logConversation(userId, "system", task.message, userSession.group);
    }

    // if (regexA.test(reply) && currentOrderId === "A") {
    //   userSession.taskFlags.trackOrderACompleted = true;
    //   logConversation(
    //     userId,
    //     "system",
    //     "Track Order A Completed",
    //     userSession.group
    //   );
    // } else if (regexB.test(reply) && currentOrderId === "B") {
    //   userSession.taskFlags.modifyOrderBCompleted = true;
    //   logConversation(
    //     userId,
    //     "system",
    //     "Modify Order B Completed",
    //     userSession.group
    //   );
    // } else if (regexC.test(reply) && currentOrderId === "C") {
    //   userSession.taskFlags.returnOrderCCompleted = true;
    //   logConversation(
    //     userId,
    //     "system",
    //     "Return Order C Completed",
    //     userSession.group
    //   );
    // }

    // log task flag status every time a response is sent
    await logConversation(
      userId,
      "system",
      `Task Flags: ${JSON.stringify(userSession.taskFlags)}`,
      userSession.group
    );

    // check if all tasks are completed
    const allTasksCompleted = checkIfAllTasksCompleted(userSession.taskFlags);

    // if all tasks are completed, log it
    if (allTasksCompleted) {
      await logConversation(
        userId,
        "system",
        "All tasks completed, prompt for questionnaire",
        userSession.group
      );
    }

    // extract options for button display
    let options = extractOptionsFromResponse(reply);
    options = cacheOptionsWithPreviouslySelected(
      options,
      currentOrderInteractions
    );

    console.log(`Reply to ${userId}: ${reply}`);
    res.json({
      reply,
      options,
      showProgressBar: false,
      tasksCompleted: allTasksCompleted,
    });
  } catch (error) {
    console.error(
      "Error while extracting options:",
      error.response ? error.response.data : error.message
    );
    res.status(500).send("Error processing the request");
  }
});

app.post("/api/end-session", async (req, res) => {
  const { userId, sessionEnd } = req.body;

  if (!userId || sessionEnd !== true) {
    return res
      .status(400)
      .send("Invalid request: missing userId or sessionEnd flag.");
  }

  const userSession = userSessions[userId];
  if (userSession) {
    const sessionStartTime = new Date(userSession.sessionStartTime);
    const sessionEndTime = new Date();
    const timeTaken = sessionEndTime - sessionStartTime;

    const totalMinutes = Math.floor(timeTaken / 60000);
    const totalSeconds = ((timeTaken % 60000) / 1000).toFixed(0);

    const timeMessage = `\n===== SESSION COMPLETED =====\nUser proceeded to the questionnaire.\nTotal time to complete tasks: ${totalMinutes} minutes and ${totalSeconds} seconds\n=============================\n`;

    // Log the completion time to Google Cloud Storage
    await logConversation(
      userId,
      "system",
      timeMessage,
      userSession.group,
      false,
      true
    );

    res.status(200).send("Session End logged.");
  } else {
    res.status(404).send("User session not found.");
  }
});

function checkIfAllTasksCompleted(taskFlags) {
  return (
    taskFlags.trackOrderACompleted &&
    taskFlags.modifyOrderBCompleted &&
    taskFlags.returnOrderCCompleted
  );
}

app.post("/api/end-session", async (req, res) => {
  const { userId, sessionEnd } = req.body;

  if (!userId || sessionEnd !== true) {
    return res
      .status(400)
      .send("Invalid request: missing userId or sessionEnd flag.");
  }

  const userSession = userSessions[userId];
  if (userSession) {
    const sessionStartTime = new Date(userSession.sessionStartTime);
    const sessionEndTime = new Date();
    // calculate total time in milliseconds
    const timeTaken = sessionEndTime - sessionStartTime;

    // calculate minutes and seconds
    const totalMinutes = Math.floor(timeTaken / 60000);
    const totalSeconds = ((timeTaken % 60000) / 1000).toFixed(0);

    const timeMessage = `\n===== SESSION COMPLETED =====\nUser proceeded to the questionnaire.\nTotal time to complete tasks: ${totalMinutes} minutes and ${totalSeconds} seconds\n=============================\n`;

    // log completion time
    await logConversation(
      userId,
      "system",
      timeMessage,
      userSession.group,
      false,
      true
    );

    res.status(200).send("Session End logged.");
  } else {
    res.status(404).send("User session not found.");
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// function to extract options from the AI response
function extractOptionsFromResponse(reply) {
  const match = reply.match(/Options:\s*([^\n\r]+)/i);
  if (match) {
    return match[1]
      .split(",")
      .map((option) => option.trim())
      .map((option) => option.replace(/[,.]$/, ""));
  }
  return [];
}

// function to mark options as "Previously Selected" based on past interactions (feature wasn't developed further)
function cacheOptionsWithPreviouslySelected(options, interactions) {
  const nonGrayedOptions = [
    "Order A",
    "Order B",
    "Order C",
    "Back to Order Operations",
    "Back to Order Selection",
  ];

  return options.map((option) => {
    if (
      interactions.includes(option) &&
      !option.includes("(Previously Selected)") &&
      !nonGrayedOptions.includes(option)
    ) {
      return `${option} (Previously Selected)`;
    }
    return option;
  });
}
