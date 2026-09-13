cask "hexbot" do
  arch arm: "arm64", intel: "x64"
  version "0.1.3"
  sha256 arm: "1bbc6c3bd42f6fab000bed6e3dfa18def982554c7569b079bb04b38a0aa31c10", intel: "f0c4b1e226ab42ff1bb9da4fd7bfb8453648bee85650942c6ee9af36cc32fc28"

  url "https://updates.hexbot.app/full/mac/#{arch}/Hexbot-#{version}-mac-#{arch}.dmg"
  name "Hexbot"
  desc "Self-hosted multi-agent desktop app"
  homepage "https://hexbot.app"

  app "Hexbot [alpha].app"

  zap trash: "~/.hexbot"
end
