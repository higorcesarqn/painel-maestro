#!/usr/bin/env node
'use strict';
/*
 * gerar-mock-prospeccao.js: grava testes/mock-prospeccao.json, o que o modo de teste (?mock=1) usa para
 * imitar /api/prospeccao/estado e /api/prospeccao/lead/<id> na tela Prospecção do painel.
 *
 * Os dados são fictícios (empresas "Exemplo", cidades "Cidade A" a "Cidade K", telefones +55 11 9000-…),
 * mas a resposta é a de verdade: o script monta uma raiz falsa em testes/tmp/ (leads em todas as etapas,
 * chips, vigia, envios, Serper) e chama o próprio api-prospeccao.js (montarEstado e detalharLead) com o
 * relógio em AGORA, o mesmo gerado_em do mock-estado.json. Nada é lido nem gravado em _maestro/estado.
 *
 * Uso: node painel/testes/gerar-mock-prospeccao.js
 */
const fs = require('fs');
const path = require('path');
const { pastaTmp, apagar, escreverJson, escreverJsonl } = require('./util');
const api = require(path.join(__dirname, '..', 'api-prospeccao.js'));

const AGORA = '2026-10-09T10:24:30-03:00'; // sexta-feira, dentro da janela de abordagem (09–19)
const T = Date.parse(AGORA);
const sp = (deltaH) => {
  const d = new Date(T + deltaH * 3600e3 - 3 * 3600e3);
  return `${d.toISOString().slice(0, 19)}-03:00`;
};
let seqTel = 10;
const celular = () => `+55119000000${String(seqTel++).padStart(2, '0')}`; // fictício: +55 11 90000-00NN
const EMPRESA = 'Empresa Exemplo'; // quem prospecta (fictício)
const OI = `Oi! Aqui é o assistente da ${EMPRESA}.`;

function lead(id, campos) {
  return Object.assign({
    id, status: 'READY_FOR_APPROACH', etapa: 'novo', origem: 'captador', telefone: null, whatsapp_confirmado: false,
    nome: null, empresa: id, instagram: null, cidade: 'Cidade A', estado: 'XX', segmento: 'varejo',
    pesquisa: null, observacao_concreta: null, gancho: null, potencial_futuro: [], prospect_score: null, classificacao: null,
    data_confidence: null, score_reason: [], distancia_km_aprox: null, numero_whatsapp: null, nota_conversa: null, temperatura: null,
    qualificacao: {}, historico: [], proximo_followup: null, followup_tipo: null, followups_feitos: 0,
    reuniao: { quando: null, link: null, confirmada: false }, notas_para_humano: '',
    humano: { ativo: false, motivo: null, desde: null, notificado_em: null, por: null },
    optout: false, abordado_em: null, ultimo_contato_em: null, ultima_mensagem_lead_em: null,
    criado_em: sp(-96), atualizado_em: sp(-30),
  }, campos);
}

// Candidato pontuado pelo captador (score, motivos, Instagram, Google, loja online).
function pontuado(id, campos) {
  const s = campos.prospect_score;
  const l = lead(id, Object.assign({
    telefone: celular(), whatsapp_confirmado: true, data_confidence: Math.max(40, s - 8),
    classificacao: s >= 90 ? 'HOT+' : s >= 80 ? 'HOT' : s >= 70 ? 'WARM' : s >= 60 ? 'QUALIFICADO' : 'DESCARTE',
    followers: 1800, has_ecommerce: false, google_reviews: 60, google_rating: 4.6, instagram_quality: 'medio',
    avaliado_em: sp(-60), criado_em: sp(-72),
  }, campos));
  // Motivos coerentes com os dados do próprio lead (pesos de exemplo).
  if (!campos.score_reason) {
    l.score_reason = [
      l.has_ecommerce ? `+5 já tem loja online (${l.ecommerce_platform || 'plataforma própria'})` : '+10 sem loja online',
      `+10 tamanho: ${(l.followers / 1000).toFixed(1).replace('.', ',')} mil seguidores`,
      l.instagram_quality === 'fraco' ? '+10 Instagram com pouca atualização' : '+5 Instagram médio, dá para melhorar',
      l.whatsapp_confirmado ? '+10 WhatsApp confirmado no site' : '-10 sem celular: só telefone fixo ou nenhum',
      `${(l.distancia_km_aprox || 10) > 40 ? '-5' : '+5'} distância da cidade-base`,
    ];
  }
  return l;
}

// Conversa: [deltaH, 'agente' | 'lead' | 'humano', texto]
const conversa = (chip, linhas) => linhas.map(([h, de, texto]) => ({ quando: sp(h), de, texto, chip }));

function montarRaiz() {
  const raiz = pastaTmp('mock-prospeccao');
  const e = path.join(raiz, 'estado', 'prospeccao');
  escreverJson(path.join(raiz, 'registro', 'agentes.json'), { versao: 1, agentes: [] });
  escreverJson(path.join(e, 'operacao.json'), {
    qualificador: { ativo: true }, captador: { ativo: true }, modo_teste: true,
    numeros_teste: ['+5511900000901', '+5511900000902'], humano: { nome: 'Dono (mock)', whatsapp: '+5511900000001' },
  });
  escreverJson(path.join(e, 'chips.json'), {
    chips: {
      'chip-01': { portal: 'WhatsApp chip-01', numero: '+5511900000101', status: 'ativo', pausado_ate: null, motivo: null, proxima_abordagem_apos: null, criado_em: sp(-200) },
      'chip-02': { portal: 'WhatsApp chip-02', numero: '+5511900000102', status: 'pausado', pausado_ate: sp(20), motivo: 'pausa de segurança: 3 bloqueios seguidos', proxima_abordagem_apos: null, criado_em: sp(-200) },
    },
  });
  escreverJson(path.join(e, 'sinais.json'), {
    chips: {
      'chip-01': { nao_lidas: 3, titulo: '(3) WhatsApp', url: 'https://web.whatsapp.com/', conectado: true, visto_em: sp(-0.01), erro: null },
      'chip-02': { nao_lidas: 0, titulo: 'WhatsApp', url: 'https://web.whatsapp.com/', conectado: true, visto_em: sp(-0.01), erro: null },
    },
    atualizado_em: sp(-0.01),
  });
  escreverJsonl(path.join(e, 'serper-chamadas.jsonl'), [
    { quando: sp(-3), endpoint: 'places', q: 'comércio local Cidade B', cache: false, status: 200 },
    { quando: sp(-2.9), endpoint: 'places', q: 'comércio local Cidade B', cache: true, status: 200 },
    { quando: sp(-2.8), endpoint: 'search', q: 'Papelaria Beta Cidade B instagram', cache: false, status: 200 },
    { quando: sp(-2.7), endpoint: 'search', q: 'Empório Exemplo Cidade D', cache: false, status: 200 },
    { quando: sp(-2.6), endpoint: 'search', q: 'Loja Exemplo Três Cidade E', cache: false, status: 500 },
    { quando: sp(-2.5), endpoint: 'places', q: 'loja de bairro Cidade D', cache: false, status: 200 },
    { quando: sp(-30), endpoint: 'search', q: 'ontem', cache: false, status: 200 },
  ]);
  fs.mkdirSync(path.join(raiz, '.segredos'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.segredos', 'serper.key'), 'chave-falsa-do-mock');

  const L = {};
  const por = (l) => { L[l.id] = l; };

  // ---- fila do qualificador (READY_FOR_APPROACH → etapa "novo")
  por(pontuado('L-alfa', { empresa: 'Loja Alfa', segmento: 'vestuário', prospect_score: 92, followers: 5400, distancia_km_aprox: 3, google_reviews: 230, google_rating: 4.8, instagram_quality: 'fraco', gancho: 'fotos', instagram: '@lojaalfa.exemplo', criado_em: sp(-20), avaliado_em: sp(-2) }));
  por(pontuado('L-beta', { empresa: 'Papelaria Beta', cidade: 'Cidade B', segmento: 'papelaria', prospect_score: 86, followers: 3100, distancia_km_aprox: 12, has_ecommerce: true, ecommerce_platform: 'Plataforma Exemplo', google_reviews: 88, instagram_quality: 'medio', gancho: 'conteudo', instagram: '@papelariabeta.exemplo', criado_em: sp(-3), avaliado_em: sp(-2.8) }));
  por(pontuado('L-gama', { empresa: 'Floricultura Gama', cidade: 'Cidade C', segmento: 'floricultura', prospect_score: 81, followers: 8900, distancia_km_aprox: 25, google_reviews: 140, google_rating: 4.7, gancho: 'loja_online', instagram: '@floriculturagama.exemplo' }));
  por(pontuado('L-delta', { empresa: 'Ótica Delta', cidade: 'Cidade D', segmento: 'ótica', prospect_score: 74, followers: 2200, distancia_km_aprox: 30, google_reviews: 41, google_rating: 4.5, instagram_quality: 'fraco', gancho: 'perfil_google', instagram: '@oticadelta.exemplo' }));
  por(pontuado('L-epsilon', { empresa: 'Pet Shop Épsilon', cidade: 'Cidade E', segmento: 'pet shop', prospect_score: 67, followers: 1500, distancia_km_aprox: 45, has_ecommerce: true, ecommerce_platform: 'Plataforma Exemplo', google_reviews: 25, google_rating: 4.4, gancho: 'conteudo', instagram: '@petshopepsilon.exemplo' }));
  por(pontuado('L-zeta', { empresa: 'Academia Zeta', cidade: 'Cidade F', segmento: 'academia', prospect_score: 63, followers: 950, distancia_km_aprox: 58, google_reviews: 12, google_rating: 4.9, instagram_quality: 'fraco', gancho: 'fotos', origem: 'importado', instagram: '@academiazeta.exemplo' }));

  // ---- pesquisado (o qualificador já leu a loja e escolheu o gancho)
  por(pontuado('L-eta', {
    empresa: 'Ateliê Eta', cidade: 'Cidade G', segmento: 'artesanato', prospect_score: 79, followers: 4100, distancia_km_aprox: 38, status: 'IN_APPROACH', etapa: 'pesquisado',
    numero_whatsapp: 'chip-01', gancho: 'fotos', instagram: '@atelieeta.exemplo',
    pesquisa: 'Ateliê com peças próprias, posta três vezes por semana. Fotos feitas com celular contra uma parede branca.',
    observacao_concreta: 'As fotos das peças novas saíram com luz amarela e a mesma parede ao fundo.',
    potencial_futuro: ['loja_online', 'conteudo'], atualizado_em: sp(-0.6),
  }));
  por(pontuado('L-teta', {
    empresa: 'Boutique Teta', cidade: 'Cidade C', segmento: 'boutique', prospect_score: 72, distancia_km_aprox: 25, status: 'IN_APPROACH', etapa: 'pesquisado',
    numero_whatsapp: 'chip-02', gancho: 'perfil_google', pesquisa: 'Loja de rua com 12 anos; perfil no Google sem fotos novas há tempo.',
    observacao_concreta: 'O perfil no Google mostra o horário antigo e só duas fotos da fachada.', atualizado_em: sp(-0.9),
  }));

  // ---- abordado (primeira mensagem enviada, sem resposta ainda)
  por(pontuado('L-iota', {
    empresa: 'Livraria Iota', cidade: 'Cidade E', segmento: 'livraria', prospect_score: 84, distancia_km_aprox: 45, status: 'IN_APPROACH', etapa: 'abordado',
    numero_whatsapp: 'chip-01', gancho: 'fotos', abordado_em: sp(-1.5), ultimo_contato_em: sp(-1.5), proximo_followup: sp(46), followup_tipo: 'sem_resposta',
    historico: conversa('chip-01', [[-1.5, 'agente', OI], [-1.49, 'agente', 'Vi as indicações de leitura que vocês postam, ficaram ótimas. As fotos dos livros vocês mesmos fazem?']]),
    atualizado_em: sp(-1.5),
  }));
  por(pontuado('L-kapa', {
    empresa: 'Estúdio Kapa', cidade: 'Cidade B', segmento: 'estúdio de pilates', prospect_score: 70, distancia_km_aprox: 12, status: 'IN_APPROACH', etapa: 'abordado',
    numero_whatsapp: 'chip-01', gancho: 'conteudo', abordado_em: sp(-2.2), ultimo_contato_em: sp(-2.2), proximo_followup: sp(45), followup_tipo: 'sem_resposta',
    historico: conversa('chip-01', [[-2.2, 'agente', OI], [-2.19, 'agente', 'Vi que vocês postam bastante vídeo das aulas. Quem cuida do conteúdo hoje?']]),
    atualizado_em: sp(-2.2),
  }));
  por(pontuado('L-lambda', {
    empresa: 'Brechó Lambda', segmento: 'brechó', prospect_score: 66, distancia_km_aprox: 2, status: 'IN_APPROACH', etapa: 'abordado',
    numero_whatsapp: 'chip-02', gancho: 'perfil_google', abordado_em: sp(-26), ultimo_contato_em: sp(-26), proximo_followup: sp(2), followup_tipo: 'sem_resposta',
    historico: conversa('chip-02', [[-26, 'agente', OI], [-25.99, 'agente', 'Procurei o brechó no Google e o horário que aparece é o antigo. Vocês sabiam?']]),
    atualizado_em: sp(-26),
  }));

  // ---- respondeu
  por(pontuado('L-mi', {
    empresa: 'Doceria Mi', cidade: 'Cidade H', segmento: 'doceria', prospect_score: 77, distancia_km_aprox: 35, status: 'CONTACTED', etapa: 'respondeu',
    numero_whatsapp: 'chip-01', gancho: 'fotos', nota_conversa: 48, temperatura: 'morno', abordado_em: sp(-5), ultimo_contato_em: sp(-0.4), ultima_mensagem_lead_em: sp(-0.4),
    historico: conversa('chip-01', [[-5, 'agente', OI], [-4.99, 'agente', 'Vi as fotos da vitrine nova, ficaram lindas. Vocês fotografam os produtos pro Instagram também?'], [-0.4, 'lead', 'Oi, quem fala? É sobre o quê?']]),
    atualizado_em: sp(-0.4),
  }));
  por(pontuado('L-ni', {
    empresa: 'Bicicletaria Ni', cidade: 'Cidade D', segmento: 'bicicletaria', prospect_score: 69, distancia_km_aprox: 30, status: 'CONTACTED', etapa: 'respondeu',
    numero_whatsapp: 'chip-01', gancho: 'conteudo', nota_conversa: 52, temperatura: 'morno', abordado_em: sp(-28), ultimo_contato_em: sp(-3), ultima_mensagem_lead_em: sp(-3),
    historico: conversa('chip-01', [[-28, 'agente', OI], [-27.99, 'agente', 'Quem cuida dos posts de vocês hoje?'], [-3, 'lead', 'eu mesma, quando sobra tempo kkk']]),
    atualizado_em: sp(-3),
  }));
  por(pontuado('L-xi', {
    empresa: 'Empório Xi', cidade: 'Cidade I', segmento: 'empório', prospect_score: 61, distancia_km_aprox: 70, status: 'CONTACTED', etapa: 'respondeu',
    numero_whatsapp: 'chip-02', gancho: 'loja_online', nota_conversa: 35, temperatura: 'frio', abordado_em: sp(-50), ultimo_contato_em: sp(-20), ultima_mensagem_lead_em: sp(-20),
    historico: conversa('chip-02', [[-50, 'agente', OI], [-49.9, 'agente', 'Vocês já pensaram em vender pela internet?'], [-20, 'lead', 'Agora não, obrigada']]),
    atualizado_em: sp(-20),
  }));

  // ---- qualificando
  por(pontuado('L-omicron', {
    empresa: 'Padaria Exemplo', segmento: 'padaria', prospect_score: 85, followers: 5400, distancia_km_aprox: 1, status: 'CONTACTED', etapa: 'qualificando',
    numero_whatsapp: 'chip-01', gancho: 'fotos', nota_conversa: 78, temperatura: 'quente', instagram: '@padariaexemplo',
    pesquisa: 'Padaria de bairro com produtos próprios. Instagram com 5,4 mil seguidores e fotos feitas no balcão.',
    observacao_concreta: 'Os pães novos têm cara de vitrine caprichada, mas as fotos estão com fundo de estoque.',
    qualificacao: { tempo_atuacao: '3 anos', qtd_produtos: 'cerca de 120', canais_venda: ['loja física', 'Instagram'], vendas_semana: '30 a 40', tem_loja_online: false, decisor: true, dor_principal: 'fotografar os produtos toma muito tempo' },
    abordado_em: sp(-26), ultimo_contato_em: sp(-1.5), ultima_mensagem_lead_em: sp(-1.5), proximo_followup: sp(20), followup_tipo: 'parou_de_responder',
    notas_para_humano: 'O dono da padaria faz as receitas. Quer entender prazos antes de conversar.',
    historico: conversa('chip-01', [
      [-26, 'agente', OI],
      [-25.99, 'agente', 'Vi os produtos novos de vocês no Instagram, ficaram muito bons.'],
      [-25, 'lead', 'Oi! Obrigado, a gente que faz tudo'],
      [-24.9, 'agente', 'Que legal. E as fotos dos produtos, vocês fazem por conta?'],
      [-24, 'lead', 'Sim, eu mesmo tiro com o celular aqui no balcão'],
      [-23.9, 'agente', 'Entendi. Quanto tempo leva pra fotografar tudo?'],
      [-2, 'lead', 'uns 3 dias, é bem corrido'],
      [-1.9, 'agente', 'Faz sentido. Posso te mandar uns exemplos de como outros comércios resolvem isso?'],
      [-1.5, 'lead', 'manda sim'],
    ]),
    atualizado_em: sp(-1.5),
  }));
  por(pontuado('L-pi', {
    empresa: 'Farmácia Pi', cidade: 'Cidade E', segmento: 'farmácia', prospect_score: 73, distancia_km_aprox: 45, status: 'CONTACTED', etapa: 'qualificando',
    numero_whatsapp: 'chip-02', gancho: 'loja_online', nota_conversa: 61, temperatura: 'morno', abordado_em: sp(-49), ultimo_contato_em: sp(-6), ultima_mensagem_lead_em: sp(-6),
    qualificacao: { tempo_atuacao: '8 anos', canais_venda: ['loja física'], tem_loja_online: false, decisor: true },
    historico: conversa('chip-02', [[-49, 'agente', OI], [-48, 'lead', 'oi'], [-47.9, 'agente', 'Vocês vendem só na loja ou também pela internet?'], [-6, 'lead', 'só na loja por enquanto, mas queria ter site']]),
    proximo_followup: sp(18), followup_tipo: 'parou_de_responder', atualizado_em: sp(-6),
  }));
  por(pontuado('L-ro', {
    empresa: 'Calçados Rô', cidade: 'Cidade C', segmento: 'calçados', prospect_score: 68, distancia_km_aprox: 25, status: 'CONTACTED', etapa: 'qualificando',
    numero_whatsapp: 'chip-01', gancho: 'sistema', nota_conversa: 57, temperatura: 'morno', abordado_em: sp(-72), ultimo_contato_em: sp(-8), ultima_mensagem_lead_em: sp(-8),
    qualificacao: { tempo_atuacao: '5 anos', qtd_produtos: '300', dor_principal: 'controle de estoque em planilha' },
    historico: conversa('chip-01', [[-72, 'agente', OI], [-70, 'lead', 'Oi'], [-8, 'lead', 'o estoque a gente controla na planilha, dá bastante erro']]),
    atualizado_em: sp(-8),
  }));

  // ---- qualificado (quentes sem reunião)
  por(pontuado('L-sigma', {
    empresa: 'Armarinho Sigma', cidade: 'Cidade F', segmento: 'armarinho', prospect_score: 80, distancia_km_aprox: 58, status: 'CONTACTED', etapa: 'qualificado',
    numero_whatsapp: 'chip-01', gancho: 'fotos', nota_conversa: 81, temperatura: 'quente', abordado_em: sp(-75), ultimo_contato_em: sp(-4), ultima_mensagem_lead_em: sp(-4),
    qualificacao: { tempo_atuacao: '15 anos', qtd_produtos: '80', canais_venda: ['loja física', 'atacado', 'Instagram'], vendas_semana: '60', tem_loja_online: false, decisor: true, dor_principal: 'catálogo sem fotos boas', servico_interesse: 'fotos', orcamento_sinal: 'perguntou prazo' },
    historico: conversa('chip-01', [[-75, 'agente', OI], [-74, 'lead', 'Oi, tudo bem?'], [-5, 'lead', 'precisamos de fotos pro catálogo até o fim do mês'], [-4.9, 'agente', `Dá tempo. O responsável aqui da ${EMPRESA} pode te mostrar como funciona numa chamada de 20 minutos. Que dia fica bom?`], [-4, 'lead', 'semana que vem pode ser']]),
    proximo_followup: sp(4), followup_tipo: 'agendar', atualizado_em: sp(-4),
  }));
  por(pontuado('L-tau', {
    empresa: 'Esportes Tau', cidade: 'Cidade J', segmento: 'artigos esportivos', prospect_score: 76, distancia_km_aprox: 75, status: 'CONTACTED', etapa: 'qualificado',
    numero_whatsapp: 'chip-02', gancho: 'loja_online', nota_conversa: 74, temperatura: 'quente', abordado_em: sp(-98), ultimo_contato_em: sp(-22), ultima_mensagem_lead_em: sp(-22),
    qualificacao: { tempo_atuacao: '4 anos', canais_venda: ['loja física', 'marketplace'], tem_loja_online: false, decisor: false, dor_principal: 'taxa do marketplace' },
    historico: conversa('chip-02', [[-98, 'agente', OI], [-22, 'lead', 'a decisão é com o meu sócio, mas tenho interesse']]),
    atualizado_em: sp(-22),
  }));

  // ---- reunião marcada
  por(pontuado('L-upsilon', {
    empresa: 'Café Úpsilon', cidade: 'Cidade K', segmento: 'cafeteria', prospect_score: 88, distancia_km_aprox: 70, status: 'CONVERTED', etapa: 'reuniao_marcada', origem: 'importado',
    numero_whatsapp: 'chip-01', gancho: 'fotos', nota_conversa: 86, temperatura: 'quente', abordado_em: sp(-120), ultimo_contato_em: sp(-3), ultima_mensagem_lead_em: sp(-3),
    reuniao: { quando: sp(5.6), link: 'https://meet.google.com/abc-defg-hij', confirmada: true },
    notas_para_humano: 'Já vende pela internet; quer fotos novas do cardápio. Decide sozinha.',
    qualificacao: { tempo_atuacao: '6 anos', qtd_produtos: '200', canais_venda: ['loja física', 'loja online'], tem_loja_online: true, decisor: true, dor_principal: 'fotos profissionais demoram', servico_interesse: 'fotos', orcamento_sinal: 'perguntou como funciona' },
    historico: conversa('chip-01', [[-120, 'agente', OI], [-4, 'lead', 'pode ser hoje às 16h?'], [-3.9, 'agente', 'Fechado: hoje às 16h, por videochamada. Te mando o link.'], [-3, 'lead', 'confirmado!']]),
    atualizado_em: sp(-3),
  }));
  por(pontuado('L-fi', {
    empresa: 'Mercearia Fi', cidade: 'Cidade E', segmento: 'mercearia', prospect_score: 75, distancia_km_aprox: 45, status: 'CONVERTED', etapa: 'reuniao_marcada',
    numero_whatsapp: 'chip-02', gancho: 'conteudo', nota_conversa: 80, temperatura: 'quente', abordado_em: sp(-140), ultimo_contato_em: sp(-10), ultima_mensagem_lead_em: sp(-10),
    reuniao: { quando: sp(27.6), link: 'https://meet.google.com/xyz-abcd-efg', confirmada: false },
    atualizado_em: sp(-10),
  }));
  por(pontuado('L-qui', {
    empresa: 'Perfumaria Qui', cidade: 'Cidade B', segmento: 'perfumaria', prospect_score: 71, distancia_km_aprox: 12, status: 'CONVERTED', etapa: 'reuniao_marcada',
    numero_whatsapp: 'chip-01', gancho: 'perfil_google', nota_conversa: 70, temperatura: 'morno', abordado_em: sp(-160), ultimo_contato_em: sp(-30), ultima_mensagem_lead_em: sp(-30),
    reuniao: { quando: sp(96), link: 'https://meet.google.com/lmn-opqr-stu', confirmada: true }, atualizado_em: sp(-30),
  }));

  // ---- com o humano (o agente passou a conversa)
  por(pontuado('L-psi', {
    empresa: 'Acessórios Psi', cidade: 'Cidade C', segmento: 'acessórios', prospect_score: 78, distancia_km_aprox: 25, status: 'CONTACTED', etapa: 'passado_humano',
    numero_whatsapp: 'chip-01', gancho: 'fotos', nota_conversa: 72, temperatura: 'quente', abordado_em: sp(-30), ultimo_contato_em: sp(-0.8), ultima_mensagem_lead_em: sp(-0.8),
    humano: { ativo: true, motivo: 'pediu proposta com valor fechado', desde: sp(-0.8), notificado_em: sp(-0.8), por: 'agente', etapa_anterior: 'qualificando' },
    notas_para_humano: 'Quer um valor fechado antes de marcar reunião.',
    historico: conversa('chip-01', [[-30, 'agente', OI], [-1, 'lead', 'quanto fica? preciso de um valor fechado'], [-0.8, 'agente', `Boa pergunta. Quem fecha valores é o responsável aqui da ${EMPRESA}: vou pedir pra ele te responder ainda hoje.`]]),
    atualizado_em: sp(-0.8),
  }));

  // ---- saídas
  por(pontuado('L-omega', { empresa: 'Loja Ômega', cidade: 'Cidade E', prospect_score: 65, status: 'DISCARDED', etapa: 'sem_resposta', numero_whatsapp: 'chip-01', abordado_em: sp(-200), ultimo_contato_em: sp(-100), followups_feitos: 2 }));
  por(pontuado('L-alfa2', { empresa: 'Sapataria Alfa Dois', cidade: 'Cidade D', segmento: 'sapataria', prospect_score: 62, status: 'DISCARDED', etapa: 'sem_resposta', numero_whatsapp: 'chip-02', abordado_em: sp(-190), ultimo_contato_em: sp(-90), followups_feitos: 2 }));
  por(pontuado('L-beta2', { empresa: 'Bazar Beta Dois', cidade: 'Cidade B', prospect_score: 70, status: 'DISCARDED', etapa: 'perdido', optout: true, numero_whatsapp: 'chip-01', abordado_em: sp(-150), ultimo_contato_em: sp(-149) }));
  por(pontuado('L-gama2', { empresa: 'Rede Gama Dois', cidade: 'Cidade E', prospect_score: 64, status: 'DISCARDED', etapa: 'desqualificado', numero_whatsapp: 'chip-02', nota_conversa: 20, temperatura: 'frio', abordado_em: sp(-170), ultimo_contato_em: sp(-160), notas_para_humano: 'Franquia: a decisão é da matriz.' }));

  // ---- captador: descobertos, investigando, sem contato e descartados
  por(lead('C-nova1', { status: 'DISCOVERED', empresa: 'Loja Recém Descoberta', cidade: 'Cidade B', criado_em: sp(-2.9), atualizado_em: sp(-2.9) }));
  por(lead('C-nova2', { status: 'DISCOVERED', empresa: 'Empório Exemplo', cidade: 'Cidade D', criado_em: sp(-2.7), atualizado_em: sp(-2.7) }));
  por(lead('C-nova3', { status: 'DISCOVERED', empresa: 'Loja Exemplo Três', cidade: 'Cidade E', criado_em: sp(-2.6), atualizado_em: sp(-2.6) }));
  por(lead('C-inv1', { status: 'INVESTIGATING', empresa: 'Galpão Exemplo', cidade: 'Cidade C', instagram: '@galpaoexemplo', criado_em: sp(-2.5), atualizado_em: sp(-0.2) }));
  por(lead('C-inv2', { status: 'INVESTIGATING', empresa: 'Ateliê Exemplo', cidade: 'Cidade E', instagram: '@atelieexemplo', criado_em: sp(-2.4), atualizado_em: sp(-0.1) }));
  por(pontuado('C-fixo1', { status: 'QUALIFIED', empresa: 'Armazém Exemplo', cidade: 'Cidade B', prospect_score: 78, telefone: '+551130000001', whatsapp_confirmado: false, instagram: '@armazemexemplo', avaliado_em: sp(-1.2) }));
  por(pontuado('C-fixo2', { status: 'QUALIFIED', empresa: 'Casa Exemplo', cidade: 'Cidade H', prospect_score: 71, telefone: '+551130000002', whatsapp_confirmado: false, instagram: '@casaexemplo' }));
  por(pontuado('C-fixo3', { status: 'QUALIFIED', empresa: 'Bazar Central Exemplo', cidade: 'Cidade F', prospect_score: 64, telefone: null, whatsapp_confirmado: false }));
  por(pontuado('C-desc1', { status: 'DISCARDED', empresa: 'Grande Rede Exemplo', cidade: 'Cidade E', prospect_score: 38, discard_reason: 'rede com mais de 20 lojas', avaliado_em: sp(-1), atualizado_em: sp(-1) }));
  por(pontuado('C-desc2', { status: 'DISCARDED', empresa: 'Atacado Exemplo', cidade: 'Cidade D', prospect_score: 45, discard_reason: 'atacado, fora do perfil', avaliado_em: sp(-1.1), atualizado_em: sp(-1.1) }));
  por(pontuado('C-desc3', { status: 'DISCARDED', empresa: 'Loja Só Online', cidade: 'Cidade C', prospect_score: 52, discard_reason: 'só vende online, sem loja física' }));
  por(pontuado('C-desc4', { status: 'DISCARDED', empresa: 'Bazar do Bairro Exemplo', prospect_score: 30, discard_reason: 'sem Instagram ativo' }));

  escreverJson(path.join(e, 'leads.json'), { versao: 1, leads: L });

  // Envios de hoje: abordagens (leads distintos) e mensagens por chip.
  const envios = [];
  for (const l of Object.values(L)) {
    for (const m of l.historico) if (m.de === 'agente') envios.push({ quando: m.quando, chip: m.chip, lead_id: l.id, telefone: l.telefone, tipo: l.abordado_em === m.quando ? 'abordagem' : 'mensagem', texto: m.texto });
  }
  escreverJsonl(path.join(e, 'envios.jsonl'), envios.sort((a, b) => a.quando.localeCompare(b.quando)));
  return { raiz, ids: Object.keys(L) };
}

const { raiz, ids } = montarRaiz();
try {
  const cfg = { maestroDir: raiz, agoraFixa: new Date(T) };
  const estado = api.montarEstado(cfg, new Date(T));
  const leads = {};
  for (const id of ids) leads[id] = api.detalharLead(cfg, new Date(T), id);
  const saida = path.join(__dirname, 'mock-prospeccao.json');
  fs.writeFileSync(saida, `${JSON.stringify({ gerado_em: estado.gerado_em, estado, leads }, null, 2)}\n`, 'utf8');
  const k = estado.qualificacao.kpis;
  console.log(`mock-prospeccao.json: ${ids.length} leads · kanban ${Object.values(estado.qualificacao.kanban).reduce((s, c) => s + c.total, 0)} · tabela ${estado.prospeccao.tabela.total} · reuniões ${k.reunioes_marcadas} · fila ${estado.prospeccao.kpis.fila}`);
} finally {
  apagar(raiz);
}
