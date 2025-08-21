const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Simple test endpoint
app.get('/', (req, res) => {
    res.send('Customer Journey Mapper is running!');
});

// In-memory storage for customer events (in production, use a real database)
let customerEvents = {};

// Helper function to add events to customer timeline
function addCustomerEvent(email, event) {
    if (!customerEvents[email]) {
        customerEvents[email] = [];
    }
    customerEvents[email].push({
        ...event,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last 50 events per customer to manage memory
    if (customerEvents[email].length > 50) {
        customerEvents[email] = customerEvents[email].slice(-50);
    }
}

// Intercom webhook - shows customer journey when agent opens conversation
app.post('/intercom/initialize', async (req, res) => {
    try {
        // Debug: log what we're receiving
        console.log('Received webhook data:', JSON.stringify(req.body, null, 2));

        const context = req.body.context || req.body;
        let customerEmail = null;

        // Try multiple ways to get customer email
        if (context && context.user && context.user.email) {
            customerEmail = context.user.email;
        } else if (context && context.lead && context.lead.email) {
            customerEmail = context.lead.email;
        } else if (context && context.contact && context.contact.email) {
            customerEmail = context.contact.email;
        } else if (req.body.user && req.body.user.email) {
            customerEmail = req.body.user.email;
        } else if (req.body.contact && req.body.contact.email) {
            customerEmail = req.body.contact.email;
        }

        console.log('Extracted customer email:', customerEmail);
        
        if (!customerEmail) {
            return res.json({
                canvas: {
                    content: {
                        components: [{
                            type: "text",
                            text: "No customer email found"
                        }]
                    }
                }
            });
        }

        // Get fresh data from all platforms
        await refreshCustomerData(customerEmail);
        
        // Get customer events timeline
        const events = customerEvents[customerEmail] || [];
        const sortedEvents = events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // Build the display components
        const components = [
            {
                type: "text",
                text: `🎯 Customer Journey: ${customerEmail}`,
                style: "header"
            },
            {
                type: "spacer",
                size: "s"
            }
        ];

        // Add timeline events
        if (sortedEvents.length > 0) {
            components.push({
                type: "text",
                text: "Recent Activity:",
                style: "header"
            });

            sortedEvents.slice(0, 10).forEach(event => {
                const date = new Date(event.timestamp).toLocaleDateString();
                const time = new Date(event.timestamp).toLocaleTimeString();
                
                components.push({
                    type: "text",
                    text: `${getEventEmoji(event.platform)} ${date} ${time}`
                });
                components.push({
                    type: "text", 
                    text: `   ${event.description}`
                });
                components.push({
                    type: "spacer",
                    size: "xs"
                });
            });
        } else {
            components.push({
                type: "text",
                text: "Loading customer data... Please refresh in a moment."
            });
        }

        res.json({
            canvas: {
                content: {
                    components: components
                }
            }
        });
        
    } catch (error) {
        console.error('Error in initialize webhook:', error);
        res.json({
            canvas: {
                content: {
                    components: [{
                        type: "text",
                        text: "Error loading customer journey - check logs"
                    }]
                }
            }
        });
    }
});

// Submit webhook (required by Intercom)
app.post('/intercom/submit', (req, res) => {
    res.json({ message: "received" });
});

// Function to get fresh data from all platforms
async function refreshCustomerData(email) {
    try {
        console.log('Refreshing data for:', email);
        
        // Get Stripe data
        await getStripeData(email);
        
        // Get Customer.io data
        await getCustomerIoData(email);
        
        // Get Linear data (if customer has reported bugs)
        await getLinearData(email);
        
        console.log('Data refresh completed for:', email);
        
    } catch (error) {
        console.error('Error refreshing customer data:', error);
    }
}

// Get Stripe billing events
async function getStripeData(email) {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            console.log('No Stripe key configured - skipping Stripe data');
            return;
        }

        console.log('Fetching Stripe data for:', email);
        
        const customers = await stripe.customers.list({
            email: email,
            limit: 1
        });
        
        if (customers.data.length === 0) {
            console.log('No Stripe customer found for:', email);
            return;
        }
        
        const customer = customers.data[0];
        console.log('Found Stripe customer:', customer.id);
        
        // Get recent charges
        const charges = await stripe.charges.list({
            customer: customer.id,
            limit: 5
        });
        
        charges.data.forEach(charge => {
            addCustomerEvent(email, {
                platform: 'stripe',
                type: 'payment',
                description: `Payment of $${charge.amount / 100} - ${charge.status}`,
                details: {
                    amount: charge.amount / 100,
                    status: charge.status,
                    charge_id: charge.id
                },
                timestamp: new Date(charge.created * 1000).toISOString()
            });
        });

        // Get subscription changes
        const subscriptions = await stripe.subscriptions.list({
            customer: customer.id,
            limit: 3
        });
        
        subscriptions.data.forEach(sub => {
            addCustomerEvent(email, {
                platform: 'stripe',
                type: 'subscription',
                description: `Subscription ${sub.status} - $${sub.items.data[0]?.price.unit_amount / 100 || 0}/month`,
                details: {
                    status: sub.status,
                    plan: sub.items.data[0]?.price.nickname || 'Unknown plan'
                },
                timestamp: new Date(sub.created * 1000).toISOString()
            });
        });
        
        console.log('Stripe data fetched successfully for:', email);
        
    } catch (error) {
        console.error('Error fetching Stripe data:', error);
    }
}

// Get Customer.io engagement data
async function getCustomerIoData(email) {
    try {
        if (!process.env.CUSTOMERIO_SITE_ID || !process.env.CUSTOMERIO_API_KEY) {
            console.log('No Customer.io credentials - adding placeholder event');
            addCustomerEvent(email, {
                platform: 'customer_io',
                type: 'email_engagement',
                description: 'Customer.io integration ready - configure API keys',
                timestamp: new Date().toISOString()
            });
            return;
        }

        console.log('Fetching Customer.io data for:', email);
        
        // Note: Customer.io API requires different authentication
        // This is a simplified example - you'll need to adjust based on their API
        
        const response = await axios.get(`https://beta-api.customer.io/v1/api/customers/${email}/activities`, {
            auth: {
                username: process.env.CUSTOMERIO_SITE_ID,
                password: process.env.CUSTOMERIO_API_KEY
            }
        });
        
        if (response.data && response.data.activities) {
            response.data.activities.slice(0, 5).forEach(activity => {
                addCustomerEvent(email, {
                    platform: 'customer_io',
                    type: 'email_engagement',
                    description: `${activity.type}: ${activity.name}`,
                    details: activity,
                    timestamp: activity.timestamp
                });
            });
        }
        
    } catch (error) {
        console.error('Error fetching Customer.io data:', error);
        // Add placeholder event
        addCustomerEvent(email, {
            platform: 'customer_io',
            type: 'email_engagement',
            description: 'Customer.io data fetch failed - check API keys',
            timestamp: new Date().toISOString()
        });
    }
}

// Get Linear bug reports
async function getLinearData(email) {
    try {
        if (!process.env.LINEAR_API_KEY) {
            console.log('No Linear API key - adding placeholder event');
            addCustomerEvent(email, {
                platform: 'linear',
                type: 'bug_report',
                description: 'Linear integration ready - configure API key',
                timestamp: new Date().toISOString()
            });
            return;
        }

        console.log('Fetching Linear data for:', email);
        
        const query = `
            query {
                issues(filter: { description: { contains: "${email}" } }) {
                    nodes {
                        id
                        title
                        description
                        state { name }
                        createdAt
                        updatedAt
                    }
                }
            }
        `;
        
        const response = await axios.post('https://api.linear.app/graphql', {
            query: query
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.LINEAR_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data.data && response.data.data.issues) {
            response.data.data.issues.nodes.forEach(issue => {
                addCustomerEvent(email, {
                    platform: 'linear',
                    type: 'bug_report',
                    description: `Bug: ${issue.title} - ${issue.state.name}`,
                    details: {
                        issue_id: issue.id,
                        status: issue.state.name
                    },
                    timestamp: issue.updatedAt
                });
            });
        }
        
    } catch (error) {
        console.error('Error fetching Linear data:', error);
        // Add placeholder event
        addCustomerEvent(email, {
            platform: 'linear',
            type: 'bug_report',
            description: 'Linear data fetch failed - check API key',
            timestamp: new Date().toISOString()
        });
    }
}

// Helper function to get emoji for each platform
function getEventEmoji(platform) {
    const emojis = {
        'stripe': '💳',
        'customer_io': '📧', 
        'linear': '🐛',
        'intercom': '💬'
    };
    return emojis[platform] || '📋';
}

// Periodic sync to keep data fresh (runs every hour)
cron.schedule('0 * * * *', async () => {
    console.log('Running periodic customer data sync...');
    // In a real implementation, you'd sync data for active customers
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Customer Journey Mapper running on port ${PORT}`);
});
