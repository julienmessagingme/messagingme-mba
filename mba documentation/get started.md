# Get started with Meta Business Agent APIs


## Prerequisites

Before you begin, make sure you have the following:

- A **WhatsApp Business Account (WABA) ID**
- An **App ID** for your Meta app
- The **whatsapp_business_messaging** permission granted to your app
- A business that operates in a [supported country and vertical](https://developers.facebook.com/documentation/meta-business-agent/overview#availability)

For an introduction to Meta Business Agent and who can use it, see the [Overview](https://developers.facebook.com/documentation/meta-business-agent/overview).

## Step 1: Set up Meta Business Agent in WhatsApp Manager

1. Go to [WhatsApp Manager](https://business.facebook.com/wa/manage/home/).
2. You should see a **Meta Business Agent** tab if any of your phone numbers are eligible.
3. Open the **Meta Business Agent** tab, and set up Meta Business Agent for any eligible phone numbers. This is also where you accept the Meta Business Agent Terms of Service.
4. Your agent won't reply to customers yet, and you should set up its knowledge and skills first (see Next steps).

**Business Solution Providers (BSPs) and Tech Providers:** your client accepts the Meta Business Agent Terms of Service in WhatsApp Manager (above). You must additionally accept the Tech Provider Terms of Service (if you haven't already done so) by becoming a Tech Provider in the [Facebook Developer Portal](https://developers.facebook.com/apps/). Meta Business Agent API calls are rejected until the required Terms of Service are accepted. For details, see [Get started for Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers).

## Step 2: Create a system user

If you already have a system user in Meta Business Suite, skip to [Step 3](#step-3-assign-the-app-to-your-system-user).

1. Go to [Meta Business Suite](https://business.facebook.com/settings/).
2. Navigate to **Users** > **System users**.
3. Click **Add** and create a new system user with the **Admin** role.

## Step 3: Assign the app to your system user

1. In Meta Business Suite, go to **Users** > **System users** and select your system user.
2. Click **Add assets**.
3. Select **Apps**, find your app, and assign it to the system user.

## Step 4: Assign the WABA to your system user

1. In Meta Business Suite, go to **Users** > **System users** and select your system user.
2. Click **Add assets**.
3. Select **WhatsApp Accounts**, find your WABA, and assign it.
4. Make sure the **View and manage phone numbers** permission is selected for the WABA.

## Step 5: Generate an access token

You can authenticate Meta Business Agent API requests using either a **system user token** or a **BISU token**, depending on your integration model.

### Option A: System user token (direct integrators)

Use this option if you are integrating directly with the Meta Business Agent APIs for your own WABA.

1. In Meta Business Suite, go to **Users** > **System users** and select your system user.
2. Click **Generate new token**.
3. Select your app from the dropdown.
4. Make sure the following permissions are selected:
   - **whatsapp_business_messaging**
   - **whatsapp_business_management**
5. Click **Generate token** and save it in a secure location.

### Option B: BISU token (BSPs and Tech Providers)

Use this option if you are a Business Solution Provider (BSP) or Tech Provider making API calls on behalf of your clients' WABAs. See the [BISU documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/#business-integration-system-user-access-tokens) for details on generating and managing BISU tokens.

Both token types require the **whatsapp_business_messaging** and **whatsapp_business_management** permissions.

## Step 6: Subscribe the app to the WABA

1. Go to the [Graph API Explorer](https://developers.facebook.com/tools/explorer/) tool.
2. Choose your app from the dropdown menu and select **Get App Token**. This opens a dialog to choose the Business Portfolio and the specific WhatsApp account. Make sure you choose the correct WABA.
3. Make a POST request to `/{WABA_ID}/subscribed_apps`. See the [Subscribed Apps API reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/subscribed-apps-api#post-version-waba-id-subscribed-apps) for details.
4. Verify the subscription by making a GET request to `/{WABA_ID}/subscribed_apps`. If successful, your app ID appears in the response.

## Step 7: Subscribe to webhook fields

1. Go to the [Facebook Developer Portal](https://developers.facebook.com/apps/) and select your app.
2. Navigate to the **WhatsApp** tab, then click **Configuration**.
3. Subscribe to the following webhook fields:
   - **messages**
   - **standby**
   - **messaging_handovers**

### Conversation routing

When Meta Business Agent is enabled, it acts as the **primary responder** for a conversation and answers the consumer directly. Your app is a **standby** participant: it still receives the consumer's messages, plus copies of the messages the agent sends on the business's behalf and their delivery and read receipts, so it stays in sync.

Which webhook field a consumer's message arrives on depends on who holds control: the **`standby`** field when Meta Business Agent holds control, and the **`messages`** field when your app holds control. A **`messaging_handovers`** webhook notifies you whenever control changes.

To respond to a conversation, your app needs control of it. Your app takes control simply by sending a message to the conversation. To hand control back to Meta Business Agent so it resumes responding, use the [Thread Control (Cloud API)](https://developers.facebook.com/documentation/meta-business-agent/reference/operate/thread-control-cloud-api) endpoint with the `pass` action.


## Next steps: configure and run your agent

Your app is connected! Set up your agent in three stages: Onboard, Configure, and Operate. You may not need every API — use only the ones your use case needs.

### Onboard

Use these APIs to check eligibility, turn your agent on or off, onboard, and manage your agent.

| Endpoint | Use it to |
|----------|-----------|
| [Eligibility](https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-eligibility) | Check whether a WhatsApp Business phone number can use Meta Business Agent. |
| [Onboarding](https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-onboarding) | Prepare the agent on a phone number — creates its configuration and knowledge. Required step before turning the agent on. |
| [Settings](https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-settings) | Turn the agent on or off, and set its behavior, persona, language, and handoff and followup policies. Enabling makes the agent start responding to new conversations. |
| [Allowlist](https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-allowlist) | Limit the agent to a specific set of consumer phone numbers — useful for a controlled rollout. |

### Configure

Shape what your agent knows and what it can do.

| Endpoint | Use it to |
|----------|-----------|
| [Skills](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/agent-skills) | Give the agent system instructions that shape how it responds. |
| [Business info](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/agent-knowledge-business-info) | Add business details, such as hours, locations, and policies, that the agent can reference. |
| [FAQs](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/agent-knowledge-faqs) | Add question-and-answer pairs to the agent's knowledge base. |
| [Websites](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/agent-knowledge-websites) | Add website URLs for the agent to crawl and reference. |
| [Files](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/agent-knowledge-files) | Upload files as knowledge sources. |
| [Connectors](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/connectors) | Define an external API the agent can call, so it can do more than answer questions. |
| [Connector tools](https://developers.facebook.com/documentation/meta-business-agent/reference/configure/connector-tools) | Define the individual operations available on a connector. |

### Operate

Run your agent in live conversations, then test and measure it.

| Endpoint | Use it to |
|----------|-----------|
| [Thread Control (Cloud API)](https://developers.facebook.com/documentation/meta-business-agent/reference/operate/thread-control-cloud-api) | Pass or take control of a conversation between your app and the agent. |
| [Agent Event](https://developers.facebook.com/documentation/meta-business-agent/reference/operate/agent-event) | Trigger an agent action for a conversation in response to a business event, such as a completed purchase. |
| [Agent test](https://developers.facebook.com/documentation/meta-business-agent/reference/operate/agent-test) | Send test messages to the agent for automated testing. |
| [Agent eval](https://developers.facebook.com/documentation/meta-business-agent/reference/operate/agent-eval) | Evaluate the agent's performance. |

### Product catalog

Your Meta product catalog is used to give Meta Business Agent product information — manage your products in Meta Commerce Manager.