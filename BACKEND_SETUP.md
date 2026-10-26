# Jornada Analytics — backend de eventos

Este repositório contém **arquivos de implantação** para Lovable Cloud/Supabase. Arquivos no GitHub **não criam automaticamente** tabelas nem publicam Edge Functions no backend conectado ao Lovable.

## Arquivos
- `supabase/migrations/20261026000000_funnel_events.sql`: tabela, RLS, índices e função atômica de ingestão com deduplicação e limite por minuto.
- `supabase/functions/track-funnel-event/index.ts`: função HTTP pública para eventos anônimos, com validação e filtro de campos.
- `supabase/config.toml`: configuração da função.

## Implantar no projeto Cloud correto
1. Abra **Jornada Analytics** no Lovable e confirme qual projeto Lovable Cloud/Supabase está conectado. **Não** aponte para o backend do quiz.
2. No ambiente conectado, aplique a migration (via mecanismo de migrations suportado no projeto ou CLI do Supabase, usando credenciais próprias).
3. Configure segredos de servidor `ANALYTICS_ALLOWED_ORIGINS` (origens HTTPS exatas do quiz, separadas por vírgulas) e `ANALYTICS_RATE_PEPPER` (valor aleatório longo). `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` devem estar disponíveis **somente no servidor**.
4. Publique a função `track-funnel-event` no projeto Cloud conectado. Verifique se `verify_jwt=false` vale só para este endpoint anônimo.
5. Teste inserção válida, idempotência do mesmo `event_id`, rejeição de campo inválido e rejeição de `purchase_confirmed`. Teste também que usuários `anon` e `authenticated` não leem a tabela.
6. Configure identidade de administrador com políticas específicas **antes** de conectar consultas do dashboard. Não foi criada uma política pública de leitura.

## Regras críticas
- A origem CORS **não autentica** o visitante. Eventos são sinais anônimos, sujeitos a abuso e bloqueadores; não são registros de pagamento.
- O frontend do quiz deve enviar somente eventos autorizados, nunca respostas religiosas, dados de contato ou chaves de serviço.
- Compras **não** passam por este endpoint: criar futuramente um webhook Wiapy separado, autenticado e idempotente.
- Precisa de política de privacidade, base legal adequada, retenção e gestão de consentimento quando aplicável.
- Rotina de limpeza: excluir buckets antigos de `ingestion_rate_limits` periodicamente; definir retenção dos eventos conforme política.
- Endereço após publicar: `https://<SEU-PROJECT-REF>.supabase.co/functions/v1/track-funnel-event`. Não invente o project ref.
