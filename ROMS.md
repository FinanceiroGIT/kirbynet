# Jogos do site

Os jogos publicados ficam em `roms/`. O arquivo `roms/index.json` define a lista mostrada no site:

```json
[
  { "name": "Nome do jogo.gba", "file": "Nome do jogo.gba" }
]
```

Para adicionar ou remover jogos, atualize os arquivos e o catálogo no mesmo commit.
O site busca o catálogo novamente a cada abertura e baixa apenas o jogo selecionado.
Arquivos adicionados à pasta do Windows depois da publicação precisam ser enviados ao repositório para aparecer no site.
