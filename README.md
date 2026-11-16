# Jogo da Velha

Jogo da Velha em HTML, CSS e JavaScript puro com suporte a **dois modos de jogo**:

- **Modo Local (Mesmo aparelho):** funciona como o clássico original — dois jogadores alternando `X` e `O` na mesma tela, com placar da sessão e destaque da linha vencedora.
- **Modo Online (Link de convite direto):** crie uma sala com um clique, copie o link de convite (`?sala=XXXXXX`) e envie para outra pessoa. Ao clicar no link, ela entra automaticamente na partida com você em tempo real, sem precisar de cadastro nem servidor dedicado.

## Como funciona o modo online

O modo online roda 100% no navegador (compatível com GitHub Pages, Vercel, Netlify ou execução local) usando comunicação em tempo real via MQTT sobre WebSocket seguro (`wss://`), com:

- Entrada direta pelo link de convite (`?sala=XXXXXX`) ou digitando o código da sala;
- Sincronização de jogadas, placar e validação de turno pelo anfitrião;
- Revanche mútua alternando quem começa a próxima rodada;
- Detecção de saída ou queda de conexão e recuperação automática ao recarregar a página.

## Executar localmente

Como o projeto é estático, basta servir os arquivos com qualquer servidor HTTP local (ex.: `npx serve` ou `python3 -m http.server 8080`) ou abrir o `index.html` no navegador.

## Testes

Execute os testes unitários da lógica e do protocolo de salas com Node.js:

```bash
npm test
```
