cask "hexbot-client" do
  arch arm: "arm64", intel: "x64"

  version "0.2.0"
  sha256 arm: "0000000000000000000000000000000000000000000000000000000000000000", intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://hexbot.app/downloads/HexbotClient-#{version}-mac-#{arch}.dmg"
  name "Hexbot Client"
  desc "Client-only Hexbot desktop app that connects to a Hexbot daemon elsewhere"
  homepage "https://hexbot.app"

  conflicts_with cask: "hexbot"

  app "Hexbot Client.app"

  zap trash: "~/.hexbot/desktop-data"
end
