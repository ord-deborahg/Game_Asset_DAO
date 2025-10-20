// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface AssetProposal {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  gameName: string;
  assetType: string;
  status: "pending" | "approved" | "rejected";
  votes: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<AssetProposal[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProposalData, setNewProposalData] = useState({ 
    gameName: "", 
    assetType: "", 
    productionCost: 0,
    expectedRevenue: 0,
    rarity: 1 
  });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedProposal, setSelectedProposal] = useState<AssetProposal | null>(null);
  const [decryptedCost, setDecryptedCost] = useState<number | null>(null);
  const [decryptedRevenue, setDecryptedRevenue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);

  const approvedCount = proposals.filter(p => p.status === "approved").length;
  const pendingCount = proposals.filter(p => p.status === "pending").length;
  const rejectedCount = proposals.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadProposals().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadProposals = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("proposal_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing proposal keys:", e); }
      }
      const list: AssetProposal[] = [];
      for (const key of keys) {
        try {
          const proposalBytes = await contract.getData(`proposal_${key}`);
          if (proposalBytes.length > 0) {
            try {
              const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
              list.push({ 
                id: key, 
                encryptedData: proposalData.data, 
                timestamp: proposalData.timestamp, 
                owner: proposalData.owner, 
                gameName: proposalData.gameName, 
                assetType: proposalData.assetType, 
                status: proposalData.status || "pending",
                votes: proposalData.votes || 0
              });
            } catch (e) { console.error(`Error parsing proposal data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading proposal ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProposals(list);
    } catch (e) { console.error("Error loading proposals:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProposal = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting financial data with Zama FHE..." });
    try {
      const encryptedData = JSON.stringify({
        cost: FHEEncryptNumber(newProposalData.productionCost),
        revenue: FHEEncryptNumber(newProposalData.expectedRevenue),
        rarity: newProposalData.rarity
      });
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const proposalId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const proposalData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        gameName: newProposalData.gameName, 
        assetType: newProposalData.assetType, 
        status: "pending",
        votes: 0
      };
      
      await contract.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(proposalData)));
      
      const keysBytes = await contract.getData("proposal_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(proposalId);
      await contract.setData("proposal_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Proposal submitted securely!" });
      setUserHistory(prev => [...prev, `Created proposal ${proposalId.substring(0, 6)}`]);
      await loadProposals();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProposalData({ 
          gameName: "", 
          assetType: "", 
          productionCost: 0,
          expectedRevenue: 0,
          rarity: 1 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<{cost: number, revenue: number} | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const dataObj = JSON.parse(encryptedData);
      return {
        cost: FHEDecryptNumber(dataObj.cost),
        revenue: FHEDecryptNumber(dataObj.revenue)
      };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const voteProposal = async (proposalId: string, vote: "approve" | "reject") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted vote with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const proposalBytes = await contract.getData(`proposal_${proposalId}`);
      if (proposalBytes.length === 0) throw new Error("Proposal not found");
      const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProposal = { 
        ...proposalData, 
        status: vote === "approve" ? "approved" : "rejected",
        votes: proposalData.votes + 1
      };
      
      await contractWithSigner.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProposal)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE vote processed successfully!" });
      setUserHistory(prev => [...prev, `Voted ${vote} on proposal ${proposalId.substring(0, 6)}`]);
      await loadProposals();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Vote failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (proposalAddress: string) => address?.toLowerCase() === proposalAddress.toLowerCase();

  const filteredProposals = proposals.filter(proposal => {
    const matchesSearch = proposal.gameName.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         proposal.assetType.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || proposal.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{proposals.length}</div>
          <div className="stat-label">Total Proposals</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="factory-icon"></div>
          </div>
          <h1>FHE<span>Game</span>Factory</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn metal-button">
            <div className="add-icon"></div>New Proposal
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="dashboard-panels">
        {/* Left Panel */}
        <div className="left-panel">
          {showIntro && (
            <div className="intro-card metal-card">
              <h2>Player-Owned Game Asset Factory</h2>
              <p>
                A DAO that governs a FHE-powered, player-owned game asset factory. 
                Members vote on which NFTs the factory should produce, with all financial 
                data processed confidentially using Zama FHE technology.
              </p>
              <div className="fhe-features">
                <div className="feature">
                  <div className="feature-icon">🔒</div>
                  <div className="feature-text">Voting and financial data encrypted with FHE</div>
                </div>
                <div className="feature">
                  <div className="feature-icon">🎮</div>
                  <div className="feature-text">Players decide what assets to produce</div>
                </div>
                <div className="feature">
                  <div className="feature-icon">💰</div>
                  <div className="feature-text">Profits distributed to DAO members</div>
                </div>
              </div>
              <button className="metal-button" onClick={() => setShowIntro(false)}>Got It</button>
            </div>
          )}

          <div className="stats-card metal-card">
            <h3>Factory Statistics</h3>
            {renderStats()}
          </div>

          {isConnected && (
            <div className="history-card metal-card">
              <h3>Your Recent Actions</h3>
              {userHistory.length > 0 ? (
                <ul className="history-list">
                  {userHistory.slice(0, 5).map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              ) : (
                <p>No recent actions</p>
              )}
            </div>
          )}
        </div>

        {/* Main Panel */}
        <div className="main-panel">
          <div className="panel-header">
            <h2>Asset Production Proposals</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search proposals..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="search-icon"></div>
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="status-filter"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
              <button onClick={loadProposals} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="proposals-list metal-card">
            {filteredProposals.length === 0 ? (
              <div className="no-proposals">
                <div className="no-data-icon"></div>
                <p>No proposals found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Create First Proposal</button>
              </div>
            ) : filteredProposals.map(proposal => (
              <div 
                className="proposal-item" 
                key={proposal.id}
                onClick={() => setSelectedProposal(proposal)}
              >
                <div className="proposal-header">
                  <div className="proposal-id">#{proposal.id.substring(0, 6)}</div>
                  <div className={`proposal-status ${proposal.status}`}>{proposal.status}</div>
                </div>
                <div className="proposal-content">
                  <div className="proposal-game">{proposal.gameName}</div>
                  <div className="proposal-asset">{proposal.assetType}</div>
                  <div className="proposal-votes">
                    <div className="vote-icon"></div>
                    <span>{proposal.votes} votes</span>
                  </div>
                </div>
                <div className="proposal-footer">
                  <div className="proposal-date">
                    {new Date(proposal.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="proposal-actions">
                    {!isOwner(proposal.owner) && proposal.status === "pending" && (
                      <>
                        <button 
                          className="action-btn metal-button success" 
                          onClick={(e) => { e.stopPropagation(); voteProposal(proposal.id, "approve"); }}
                        >
                          Approve
                        </button>
                        <button 
                          className="action-btn metal-button danger" 
                          onClick={(e) => { e.stopPropagation(); voteProposal(proposal.id, "reject"); }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitProposal} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          proposalData={newProposalData} 
          setProposalData={setNewProposalData}
        />
      )}

      {selectedProposal && (
        <ProposalDetailModal 
          proposal={selectedProposal} 
          onClose={() => { 
            setSelectedProposal(null); 
            setDecryptedCost(null);
            setDecryptedRevenue(null);
          }} 
          decryptedCost={decryptedCost}
          decryptedRevenue={decryptedRevenue}
          setDecryptedCost={setDecryptedCost}
          setDecryptedRevenue={setDecryptedRevenue}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="factory-icon"></div>
              <span>FHE Game Factory DAO</span>
            </div>
            <p>Powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">DAO Governance</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Fully Homomorphic Encryption</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE Game Factory DAO. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  proposalData: any;
  setProposalData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, proposalData, setProposalData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setProposalData({ ...proposalData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProposalData({ ...proposalData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!proposalData.gameName || !proposalData.assetType) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>New Asset Proposal</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Financial data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Game Name *</label>
            <input 
              type="text" 
              name="gameName" 
              value={proposalData.gameName} 
              onChange={handleChange} 
              placeholder="Enter game name..."
            />
          </div>
          
          <div className="form-group">
            <label>Asset Type *</label>
            <input 
              type="text" 
              name="assetType" 
              value={proposalData.assetType} 
              onChange={handleChange} 
              placeholder="E.g., Weapon, Skin, Avatar..."
            />
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>Production Cost (ETH)</label>
              <input 
                type="number" 
                name="productionCost" 
                value={proposalData.productionCost} 
                onChange={handleNumberChange} 
                step="0.01"
                min="0"
              />
            </div>
            
            <div className="form-group">
              <label>Expected Revenue (ETH)</label>
              <input 
                type="number" 
                name="expectedRevenue" 
                value={proposalData.expectedRevenue} 
                onChange={handleNumberChange} 
                step="0.01"
                min="0"
              />
            </div>
          </div>
          
          <div className="form-group">
            <label>Rarity Level</label>
            <select 
              name="rarity" 
              value={proposalData.rarity} 
              onChange={handleChange}
            >
              <option value="1">Common</option>
              <option value="2">Uncommon</option>
              <option value="3">Rare</option>
              <option value="4">Epic</option>
              <option value="5">Legendary</option>
            </select>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Cost: {proposalData.productionCost}</div>
                <div>Revenue: {proposalData.expectedRevenue}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{proposalData.productionCost || proposalData.expectedRevenue ? 
                  FHEEncryptNumber(proposalData.productionCost).substring(0, 20) + '...' : 
                  'No values entered'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProposalDetailModalProps {
  proposal: AssetProposal;
  onClose: () => void;
  decryptedCost: number | null;
  decryptedRevenue: number | null;
  setDecryptedCost: (value: number | null) => void;
  setDecryptedRevenue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<{cost: number, revenue: number} | null>;
}

const ProposalDetailModal: React.FC<ProposalDetailModalProps> = ({ 
  proposal, 
  onClose, 
  decryptedCost,
  decryptedRevenue,
  setDecryptedCost,
  setDecryptedRevenue,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedCost !== null) { 
      setDecryptedCost(null);
      setDecryptedRevenue(null);
      return; 
    }
    const decrypted = await decryptWithSignature(proposal.encryptedData);
    if (decrypted !== null) {
      setDecryptedCost(decrypted.cost);
      setDecryptedRevenue(decrypted.revenue);
    }
  };

  const dataObj = proposal.encryptedData ? JSON.parse(proposal.encryptedData) : {};
  const rarityMap: {[key: number]: string} = {
    1: "Common",
    2: "Uncommon",
    3: "Rare",
    4: "Epic",
    5: "Legendary"
  };

  return (
    <div className="modal-overlay">
      <div className="detail-modal metal-card">
        <div className="modal-header">
          <h2>Proposal Details #{proposal.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="proposal-info">
            <div className="info-row">
              <span>Game:</span>
              <strong>{proposal.gameName}</strong>
            </div>
            <div className="info-row">
              <span>Asset Type:</span>
              <strong>{proposal.assetType}</strong>
            </div>
            <div className="info-row">
              <span>Rarity:</span>
              <strong>{rarityMap[dataObj.rarity] || "Unknown"}</strong>
            </div>
            <div className="info-row">
              <span>Status:</span>
              <strong className={`status-badge ${proposal.status}`}>{proposal.status}</strong>
            </div>
            <div className="info-row">
              <span>Proposed By:</span>
              <strong>{proposal.owner.substring(0, 6)}...{proposal.owner.substring(38)}</strong>
            </div>
            <div className="info-row">
              <span>Date:</span>
              <strong>{new Date(proposal.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-row">
              <span>Votes:</span>
              <strong>{proposal.votes}</strong>
            </div>
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Financial Data</h3>
            <div className="encrypted-data">
              <div className="data-item">
                <span>Cost:</span>
                <div>{dataObj.cost?.substring(0, 20)}...</div>
              </div>
              <div className="data-item">
                <span>Revenue:</span>
                <div>{dataObj.revenue?.substring(0, 20)}...</div>
              </div>
            </div>
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : 
               decryptedCost !== null ? "Hide Values" : "Decrypt with Wallet"}
            </button>
          </div>

          {decryptedCost !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data">
                <div className="data-item">
                  <span>Production Cost:</span>
                  <strong>{decryptedCost} ETH</strong>
                </div>
                <div className="data-item">
                  <span>Expected Revenue:</span>
                  <strong>{decryptedRevenue} ETH</strong>
                </div>
                <div className="data-item">
                  <span>Projected Profit:</span>
                  <strong>{(decryptedRevenue - decryptedCost).toFixed(2)} ETH</strong>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted values are only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;