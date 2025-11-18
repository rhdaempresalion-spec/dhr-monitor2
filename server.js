import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// CARREGAR VARIÁVEIS DE AMBIENTE
// ============================================

function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, 'utf8');
      envFile.split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          const [key, ...valueParts] = line.split('=');
          const value = valueParts.join('=');
          if (key && value) {
            process.env[key.trim()] = value.trim();
          }
        }
      });
    }
  } catch (error) {
    console.error('Erro ao carregar .env:', error.message);
  }
}

loadEnv();

const CONFIG = {
  DHR_PUBLIC_KEY: process.env.DHR_PUBLIC_KEY,
  DHR_SECRET_KEY: process.env.DHR_SECRET_KEY,
  DHR_API_URL: process.env.DHR_API_URL || 'https://api.dhrtecnologialtda.com/v1',
  CHECK_INTERVAL_SECONDS: parseInt(process.env.CHECK_INTERVAL_SECONDS || '5'),
  PORT: parseInt(process.env.PORT || '3000')
};

// Validar configurações
if (!CONFIG.DHR_PUBLIC_KEY || !CONFIG.DHR_SECRET_KEY) {
  console.error('❌ ERRO: Chaves da API DHR não configuradas!');
  process.exit(1);
}

// ============================================
// GERENCIAMENTO DE NOTIFICAÇÕES
// ============================================

const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const PROCESSED_FILE = path.join(__dirname, 'processed_events.json');

// Carregar notificações salvas
function loadNotifications() {
  try {
    if (fs.existsSync(NOTIFICATIONS_FILE)) {
      const data = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Erro ao carregar notificações:', error.message);
  }
  return [];
}

// Salvar notificações
function saveNotifications(notifications) {
  try {
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2));
    return true;
  } catch (error) {
    console.error('Erro ao salvar notificações:', error.message);
    return false;
  }
}

// Carregar eventos processados
function loadProcessedEvents() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = fs.readFileSync(PROCESSED_FILE, 'utf8');
      return new Set(JSON.parse(data));
    }
  } catch (error) {
    console.error('Erro ao carregar eventos processados:', error.message);
  }
  return new Set();
}

// Salvar eventos processados
function saveProcessedEvents(events) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...events], null, 2));
  } catch (error) {
    console.error('Erro ao salvar eventos processados:', error.message);
  }
}

let notifications = loadNotifications();
let processedEvents = loadProcessedEvents();

// ============================================
// FUNÇÕES DA API DHR
// ============================================

async function fetchDHRTransactions() {
  try {
    const auth = Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
    
    const response = await fetch(`${CONFIG.DHR_API_URL}/transactions?page=1&pageSize=50`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('❌ Erro ao buscar transações:', error.message);
    return [];
  }
}

async function fetchDHRWithdrawals() {
  try {
    const auth = Buffer.from(`${CONFIG.DHR_PUBLIC_KEY}:${CONFIG.DHR_SECRET_KEY}`).toString('base64');
    
    const response = await fetch(`${CONFIG.DHR_API_URL}/withdrawals?page=1&pageSize=50`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('❌ Erro ao buscar saques:', error.message);
    return [];
  }
}

// ============================================
// FUNÇÕES DE NOTIFICAÇÃO
// ============================================

function replaceTemplateVariables(template, data, eventType) {
  let amount = 0;
  let customerName = 'N/A';
  let customerEmail = 'N/A';
  let customerDocument = 'N/A';
  let paymentMethod = 'N/A';
  let id = 'N/A';
  let installments = 1;
  
  if (eventType === 'withdrawal_requested' || eventType === 'withdrawal_approved') {
    // Dados de saque
    amount = data.amount || 0;
    id = data.id;
    customerName = 'Você';
  } else {
    // Dados de transação
    amount = data.amount || 0;
    customerName = data.customer?.name || 'Cliente';
    customerEmail = data.customer?.email || 'N/A';
    customerDocument = data.customer?.document || 'N/A';
    paymentMethod = data.paymentMethod || 'N/A';
    id = data.id;
    installments = data.installments || 1;
  }
  
  const formattedAmount = (amount / 100).toFixed(2);
  const currentDate = new Date().toLocaleString('pt-BR');

  return template
    .replace(/{VALOR}/g, `R$ ${formattedAmount}`)
    .replace(/{CLIENTE}/g, customerName)
    .replace(/{EMAIL}/g, customerEmail)
    .replace(/{DOCUMENTO}/g, customerDocument)
    .replace(/{METODO}/g, paymentMethod)
    .replace(/{ID}/g, id)
    .replace(/{DATA}/g, currentDate)
    .replace(/{PARCELAS}/g, installments);
}

async function sendPushNotification(url, title, text, data) {
  try {
    const payload = {
      title: title,
      text: text,
      input: {
        data: new Date().toLocaleString('pt-BR')
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return true;
  } catch (error) {
    console.error(`❌ Erro ao enviar para ${url}:`, error.message);
    return false;
  }
}

// ============================================
// MONITORAMENTO DE EVENTOS
// ============================================

async function checkForNewEvents() {
  try {
    // Buscar transações
    const transactions = await fetchDHRTransactions();
    
    // Buscar saques
    const withdrawals = await fetchDHRWithdrawals();
    
    let hasNewEvents = false;

    // Processar vendas pagas
    const paidTransactions = transactions.filter(t => 
      t.status === 'paid' && !processedEvents.has(`transaction-${t.id}-paid`)
    );

    for (const transaction of paidTransactions) {
      hasNewEvents = true;
      await processEvent('sale_paid', transaction);
      processedEvents.add(`transaction-${transaction.id}-paid`);
    }

    // Processar reembolsos
    const refundedTransactions = transactions.filter(t => 
      (t.status === 'refunded' || t.status === 'chargeback') && 
      !processedEvents.has(`transaction-${t.id}-refunded`)
    );

    for (const transaction of refundedTransactions) {
      hasNewEvents = true;
      await processEvent('refund', transaction);
      processedEvents.add(`transaction-${transaction.id}-refunded`);
    }

    // Processar saques solicitados
    const requestedWithdrawals = withdrawals.filter(w => 
      w.status === 'pending' && !processedEvents.has(`withdrawal-${w.id}-requested`)
    );

    for (const withdrawal of requestedWithdrawals) {
      hasNewEvents = true;
      await processEvent('withdrawal_requested', withdrawal);
      processedEvents.add(`withdrawal-${withdrawal.id}-requested`);
    }

    // Processar saques aprovados
    const approvedWithdrawals = withdrawals.filter(w => 
      w.status === 'approved' && !processedEvents.has(`withdrawal-${w.id}-approved`)
    );

    for (const withdrawal of approvedWithdrawals) {
      hasNewEvents = true;
      await processEvent('withdrawal_approved', withdrawal);
      processedEvents.add(`withdrawal-${withdrawal.id}-approved`);
    }

    if (!hasNewEvents) {
      console.log(`ℹ️  [${new Date().toLocaleString('pt-BR')}] Nenhum novo evento`);
    }

    saveProcessedEvents(processedEvents);
  } catch (error) {
    console.error('❌ Erro ao verificar eventos:', error.message);
  }
}

async function processEvent(eventType, data) {
  const amount = (data.amount / 100).toFixed(2);
  const customerName = data.customer?.name || 'Você';

  console.log(`\n🎉 Novo evento: ${eventType}`);
  console.log(`   ID: ${data.id}`);
  console.log(`   Valor: R$ ${amount}`);

  // Filtrar notificações para este tipo de evento
  const relevantNotifications = notifications.filter(n => 
    n.enabled && n.eventType === eventType
  );

  if (relevantNotifications.length === 0) {
    console.log(`   ⚠️  Nenhuma notificação configurada para ${eventType}`);
    return;
  }

  // Enviar para todas as URLs configuradas para este evento
  for (const notification of relevantNotifications) {
    const title = replaceTemplateVariables(notification.title, data, eventType);
    const text = replaceTemplateVariables(notification.text, data, eventType);

    console.log(`   📤 Enviando para: ${notification.name}`);
    
    const success = await sendPushNotification(
      notification.url,
      title,
      text,
      data
    );

    if (success) {
      console.log(`   ✅ Enviado com sucesso!`);
    } else {
      console.log(`   ❌ Falha no envio`);
    }
  }

  console.log(`✔️  Evento ${data.id} processado\n`);
}

// ============================================
// SERVIDOR WEB E API
// ============================================

const app = express();
app.use(express.json());
app.use(express.static('public'));

// API: Listar notificações
app.get('/api/notifications', (req, res) => {
  res.json(notifications);
});

// API: Adicionar notificação
app.post('/api/notifications', (req, res) => {
  const { name, url, title, text, enabled, eventType } = req.body;

  if (!name || !url || !title || !text || !eventType) {
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  }

  const newNotification = {
    id: Date.now().toString(),
    name,
    url,
    title,
    text,
    eventType,
    enabled: enabled !== false
  };

  notifications.push(newNotification);
  saveNotifications(notifications);

  res.json(newNotification);
});

// API: Atualizar notificação
app.put('/api/notifications/:id', (req, res) => {
  const { id } = req.params;
  const { name, url, title, text, enabled, eventType } = req.body;

  const index = notifications.findIndex(n => n.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Notificação não encontrada' });
  }

  notifications[index] = {
    ...notifications[index],
    name: name || notifications[index].name,
    url: url || notifications[index].url,
    title: title || notifications[index].title,
    text: text || notifications[index].text,
    eventType: eventType || notifications[index].eventType,
    enabled: enabled !== undefined ? enabled : notifications[index].enabled
  };

  saveNotifications(notifications);
  res.json(notifications[index]);
});

// API: Deletar notificação
app.delete('/api/notifications/:id', (req, res) => {
  const { id } = req.params;
  
  const index = notifications.findIndex(n => n.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Notificação não encontrada' });
  }

  notifications.splice(index, 1);
  saveNotifications(notifications);
  
  res.json({ success: true });
});

// API: Status do sistema
app.get('/api/status', (req, res) => {
  res.json({
    running: true,
    interval: CONFIG.CHECK_INTERVAL_SECONDS,
    processedCount: processedEvents.size,
    notificationsCount: notifications.length,
    activeNotifications: notifications.filter(n => n.enabled).length
  });
});

// API: Testar notificação
app.post('/api/test/:id', async (req, res) => {
  const { id } = req.params;
  
  const notification = notifications.find(n => n.id === id);
  if (!notification) {
    return res.status(404).json({ error: 'Notificação não encontrada' });
  }

  const testData = {
    id: 'TEST-' + Date.now(),
    amount: 10000,
    customer: { name: 'Cliente Teste', email: 'teste@email.com', document: '123.456.789-00' },
    paymentMethod: 'pix',
    installments: 1
  };

  const title = replaceTemplateVariables(notification.title, testData, notification.eventType);
  const text = replaceTemplateVariables(notification.text, testData, notification.eventType);

  const success = await sendPushNotification(notification.url, title, text, testData);
  
  res.json({ success, title, text });
});

// Iniciar servidor
app.listen(CONFIG.PORT, () => {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  🚀 Sistema DHR com Múltiplos Eventos                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('📋 Configurações:');
  console.log(`   • Porta: ${CONFIG.PORT}`);
  console.log(`   • Intervalo: ${CONFIG.CHECK_INTERVAL_SECONDS} segundos`);
  console.log(`   • Notificações configuradas: ${notifications.length}`);
  console.log(`   • Eventos processados: ${processedEvents.size}`);
  console.log('');
  console.log(`🌐 Interface web: http://localhost:${CONFIG.PORT}`);
  console.log('');
  console.log('📱 Tipos de eventos monitorados:');
  console.log('   • 💰 Venda Paga (sale_paid)');
  console.log('   • 💸 Saque Solicitado (withdrawal_requested)');
  console.log('   • ✅ Saque Aprovado (withdrawal_approved)');
  console.log('   • 🔄 Reembolso (refund)');
  console.log('');
  console.log('✅ Sistema iniciado!');
  console.log('📱 Monitorando eventos...');
  console.log('');

  // Iniciar monitoramento
  checkForNewEvents();
  setInterval(checkForNewEvents, CONFIG.CHECK_INTERVAL_SECONDS * 1000);
});

// Tratamento de erros
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promise rejeitada:', error);
});
