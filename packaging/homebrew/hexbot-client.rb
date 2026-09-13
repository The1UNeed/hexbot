cask "hexbot-client" do
  arch arm: "arm64", intel: "x64"
  version "0.1.3"
  sha256 arm: "af91538397999f9f3bbd2a106aa5d9591bd33dc8f793184af7706087b5356845", intel: "f0d1f4cc9021bad57adbe903f3c9a4043ed729540fef9087f1fc1a3cb2e99ed5"

  url "https://updates.hexbot.app/client/mac/#{arch}/HexbotClient-#{version}-mac-#{arch}.dmg"
  name "Hexbot Client"
  desc "Client-only Hexbot desktop app that connects to a Hexbot daemon elsewhere"
  homepage "https://hexbot.app"

  conflicts_with cask: "hexbot"

  app "Hexbot Client [alpha].app"

  zap trash: "~/.hexbot/desktop-data"
end
